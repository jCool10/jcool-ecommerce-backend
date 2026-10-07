import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { DrizzleTx } from '@shared/infrastructure/database';
import { OUTBOX_WRITER, type OutboxWriterPort } from '@shared/messaging/outbox/outbox-writer.port';
import { headerAfterAuthorization } from '../../domain/payment-order-fence';
import type { PaymentOrderStatus } from '../../domain/payment-order-status';
import { PaymentStatus } from '../../domain/payment-status';
import type { SessionAuthorization } from '../ports/payment-gateway.port';
import { PAYMENT_ORDER_REPOSITORY, type PaymentOrderRepositoryPort } from '../ports/payment-order-repository.port';
import { PAYMENT_REPOSITORY, type PaymentRepositoryPort } from '../ports/payment-repository.port';
import { chargeMatchesPayment } from '../mappers/charge-matches-payment';
import { toAuthorizedOutboxRecord } from '../payment-outbox.mapper';

const LOG_CONTEXT = 'RecordAuthorization';

export interface AuthorizationToRecord {
  /** From the caller's unlocked read before its transaction; the header is locked by it. */
  orderId: string;
  providerSessionId: string;
  authorization: SessionAuthorization;
  authorizedAt: Date;
  /** Minted before the caller's transaction opened. */
  outboxId: string;
}

export type RecordAuthorizationResult =
  | { outcome: 'authorized'; paymentId: string; headerStatus: PaymentOrderStatus }
  | {
      outcome: 'skipped';
      reason: 'not_authorized' | 'payment_not_found' | 'already_recorded' | 'conflict' | 'amount_mismatch';
    };

/**
 * Shared by the webhook and the reconcile sweep, inside the caller's transaction. A hold landing under
 * a cancelled header is still recorded and announced: the saga then voids it, which it can only do
 * for a hold it knows about.
 */
@Injectable()
export class RecordAuthorizationUseCase {
  constructor(
    @Inject(PAYMENT_ORDER_REPOSITORY) private readonly headers: PaymentOrderRepositoryPort,
    @Inject(PAYMENT_REPOSITORY) private readonly payments: PaymentRepositoryPort,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriterPort,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(LOG_CONTEXT);
  }

  async execute(tx: DrizzleTx, input: AuthorizationToRecord): Promise<RecordAuthorizationResult> {
    const { authorization, orderId } = input;
    if (authorization.intentStatus !== 'requires_capture' || authorization.intentId === undefined) {
      return { outcome: 'skipped', reason: 'not_authorized' };
    }

    const header = await this.headers.findForUpdate(tx, orderId);
    if (header === null) return { outcome: 'skipped', reason: 'payment_not_found' };
    const payment = await this.payments.findByProviderSessionId(input.providerSessionId, tx);
    if (payment === null || payment.id === null || payment.orderId !== orderId) {
      return { outcome: 'skipped', reason: 'payment_not_found' };
    }
    if (payment.status !== PaymentStatus.PENDING) {
      return {
        outcome: 'skipped',
        reason: payment.status === PaymentStatus.AUTHORIZED ? 'already_recorded' : 'conflict',
      };
    }

    const held = { amountMinor: authorization.amountCapturableMinor, currency: authorization.currency };
    const matchesHeader =
      header.amountMinor !== null &&
      header.currency !== null &&
      held.amountMinor === header.amountMinor &&
      held.currency?.toUpperCase() === header.currency;
    if (!matchesHeader || !chargeMatchesPayment(payment, held)) {
      this.logger.error(
        {
          orderId,
          paymentId: payment.id,
          expected: { header: [header.amountMinor, header.currency], payment: [payment.amountMinor, payment.currency] },
          held,
        },
        'authorization does not match the money this order was opened for — not recorded',
      );
      return { outcome: 'skipped', reason: 'amount_mismatch' };
    }

    const authorized = payment.markAuthorized(authorization.intentId, input.authorizedAt);
    const updated = await this.payments.updateStatus(payment.id, authorized.status, {
      tx,
      providerIntentId: authorized.providerIntentId,
      authorizedAt: input.authorizedAt,
      expectedStatus: PaymentStatus.PENDING,
    });
    if (updated === null) throw new Error(`payment vanished mid-transaction: ${payment.id}`);

    const headerStatus = headerAfterAuthorization(header.status);
    if (headerStatus !== header.status) {
      await this.headers.updateStatus(tx, orderId, headerStatus, header.status);
    }
    await this.outbox.append(
      tx,
      toAuthorizedOutboxRecord({
        paymentId: payment.id,
        orderId,
        amountMinor: payment.amountMinor,
        currency: payment.currency,
        authorizedAt: input.authorizedAt,
      }),
      input.outboxId,
    );
    return { outcome: 'authorized', paymentId: payment.id, headerStatus };
  }
}
