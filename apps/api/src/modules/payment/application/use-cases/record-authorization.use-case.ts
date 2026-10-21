import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { METRICS, type MetricsPort, type TccBranchOutcome } from '@jcool/metrics-port';
import type { DrizzleTx } from '@shared/infrastructure/database';
import { ID_GENERATOR, type IdGeneratorPort, mintOne } from '@shared/identity/id-generator.port';
import { OUTBOX_WRITER, type OutboxWriterPort } from '@shared/messaging/outbox/outbox-writer.port';
import { decideAuthorization } from '../../domain/authorization-decision';
import { PaymentOrderStatus } from '../../domain/payment-order-status';
import { PaymentStatus } from '../../domain/payment-status';
import type { Payment } from '../../domain/payment.entity';
import { withIntentKey } from '../intent-idempotency-key';
import { toAuthorizedOutboxRecord } from '../payment-outbox.mapper';
import { PAYMENT_GATEWAY, type PaymentGatewayPort, type SessionAuthorization } from '../ports/payment-gateway.port';
import { PAYMENT_ORDER_REPOSITORY, type PaymentOrderRepositoryPort } from '../ports/payment-order-repository.port';
import { PAYMENT_REPOSITORY, type PaymentRepositoryPort } from '../ports/payment-repository.port';
import { TRANSACTION_RUNNER, type TransactionRunnerPort } from '../ports/transaction-runner.port';

const LOG_CONTEXT = 'RecordAuthorization';

/** The state moved under the lock in a way that needs work outside the transaction first. */
export class WebhookRetryLaterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookRetryLaterError';
  }
}

export type AuthorizationOutcome = Extract<
  TccBranchOutcome,
  'recorded' | 'recorded_late' | 'already_recorded' | 'amount_mismatch' | 'stray_voided'
>;

/** What the card holds, as Stripe reports it. */
export interface HeldCharge {
  intentId: string;
  amountMinor?: number;
  currency?: string;
}

export interface PreparedAuthorization {
  paymentId: string;
  orderId: string;
  providerSessionId: string;
  hold: HeldCharge;
  authorizedAt: Date;
  strayVoided: boolean;
  /** Minted only when the unlocked read says this hold gets recorded. */
  outboxId: string | null;
}

/** A completed session whose card now holds the money, waiting for capture. */
export function heldCharge(authorization: SessionAuthorization): HeldCharge | null {
  if (authorization.sessionStatus !== 'complete' || authorization.intentStatus !== 'requires_capture') return null;
  if (!authorization.intentId) return null;
  return {
    intentId: authorization.intentId,
    amountMinor: authorization.amountCapturableMinor,
    currency: authorization.currency,
  };
}

/**
 * Turns a hold Stripe reports into `payment.authorized`, at most once per order. Split in two so the
 * webhook can run `apply` inside its own transaction: `prepare` reads unlocked, voids a stray hold
 * and mints, all outside any transaction; `apply` decides again on the locked rows and writes.
 */
@Injectable()
export class RecordAuthorizationUseCase {
  constructor(
    @Inject(TRANSACTION_RUNNER) private readonly transactionRunner: TransactionRunnerPort,
    @Inject(PAYMENT_ORDER_REPOSITORY) private readonly headers: PaymentOrderRepositoryPort,
    @Inject(PAYMENT_REPOSITORY) private readonly payments: PaymentRepositoryPort,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGatewayPort,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriterPort,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGeneratorPort,
    @Inject(METRICS) private readonly metrics: MetricsPort,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(LOG_CONTEXT);
  }

  async record(payment: Payment, hold: HeldCharge, authorizedAt: Date): Promise<AuthorizationOutcome> {
    try {
      const prepared = await this.prepare(payment, hold, authorizedAt);
      const outcome = await this.transactionRunner.run((tx) => this.apply(tx, prepared));
      this.count(outcome);
      return outcome;
    } catch (error) {
      this.count('error');
      throw error;
    }
  }

  async prepare(read: Payment, hold: HeldCharge, authorizedAt: Date): Promise<PreparedAuthorization> {
    // Callers read the payment before a Stripe round-trip, so read it again. Header first: apply
    // commits both together, so a header showing a recorded hold implies a payment showing it too.
    const header = await this.headers.find(read.orderId);
    const payment = await this.payments.findByProviderSessionId(read.providerSessionId);
    if (!header || payment?.id !== read.id) {
      throw new Error(`payment ${read.id} or its payment_orders header is missing`);
    }

    const prepared: PreparedAuthorization = {
      paymentId: payment.id as string,
      orderId: payment.orderId,
      providerSessionId: payment.providerSessionId,
      hold,
      authorizedAt,
      strayVoided: false,
      outboxId: null,
    };
    const decision = decideAuthorization({ payment, header, charge: hold });
    if (decision === 'STRAY') {
      await this.voidStray(payment, hold.intentId);
      return { ...prepared, strayVoided: true };
    }
    if (decision === 'RECORD' || decision === 'RECORD_LATE') {
      return { ...prepared, outboxId: await mintOne(this.idGenerator) };
    }
    return prepared;
  }

  async apply(tx: DrizzleTx, prepared: PreparedAuthorization): Promise<AuthorizationOutcome> {
    const { orderId, paymentId, hold, authorizedAt } = prepared;
    const header = await this.headers.findForUpdate(tx, orderId);
    const payment = await this.payments.findByProviderSessionId(prepared.providerSessionId, tx);
    if (!header || payment?.id !== paymentId) {
      throw new Error(`payment ${paymentId} or its header vanished under the lock`);
    }

    const decision = decideAuthorization({ payment, header, charge: hold });
    switch (decision) {
      case 'ALREADY_RECORDED':
        return 'already_recorded';
      case 'AMOUNT_MISMATCH':
        this.logger.error(
          { orderId, paymentId, expected: { amountMinor: header.amountMinor, currency: header.currency }, hold },
          'authorization does not match the order total; left for the cancel to void',
        );
        return 'amount_mismatch';
      case 'STRAY':
        if (!prepared.strayVoided) {
          throw new WebhookRetryLaterError(`authorization of payment ${paymentId} turned stray under the lock`);
        }
        return 'stray_voided';
    }
    if (prepared.outboxId === null) {
      throw new WebhookRetryLaterError(`authorization of payment ${paymentId} became recordable under the lock`);
    }

    const authorized = payment.markAuthorized(hold.intentId);
    await this.payments.updateStatus(paymentId, authorized.status, {
      providerIntentId: authorized.providerIntentId,
      expectedStatus: PaymentStatus.PENDING,
      tx,
    });
    // A cancelled header stays cancelled: the saga voids a late hold, it never revives the order.
    await this.headers.update(tx, orderId, {
      ...(decision === 'RECORD' && { status: PaymentOrderStatus.AUTHORIZED }),
      authorizedAt,
    });
    await this.outbox.append(
      tx,
      toAuthorizedOutboxRecord({
        paymentId,
        orderId,
        amountMinor: payment.amountMinor,
        currency: payment.currency,
        authorizedAt,
      }),
      { id: prepared.outboxId },
    );
    return decision === 'RECORD' ? 'recorded' : 'recorded_late';
  }

  /** For callers running `prepare`/`apply` themselves: count once their transaction has settled. */
  count(outcome: AuthorizationOutcome | 'error'): void {
    this.metrics.recordTccBranch('payment', 'record_authorization', outcome);
  }

  private async voidStray(payment: Payment, intentId: string): Promise<void> {
    const outcome = await withIntentKey(this.payments, payment, 'void', (key) =>
      this.gateway.voidIntent(intentId, key),
    );
    const context = { orderId: payment.orderId, paymentId: payment.id, intentId };
    if (outcome === 'already_captured') {
      this.metrics.recordCaptureConflict();
      this.logger.error(context, 'stray authorization was already captured');
      return;
    }
    this.logger.warn(context, "voided an authorization that is not the order's current attempt");
  }
}
