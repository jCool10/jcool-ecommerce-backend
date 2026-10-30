import { Inject, Injectable } from '@nestjs/common';
import type { DrizzleTx } from '../../../../database';
import { ID_GENERATOR, type IdGeneratorPort, mintOne } from '../ports/id-generator.port';
import { PaymentStatus } from '../../domain/payment-status';
import type { Payment } from '../../domain/payment.entity';
import { readCheckoutSession } from '../mappers/read-checkout-session';
import { PAYMENT_GATEWAY, type PaymentGatewayPort, type VerifiedEvent } from '../ports/payment-gateway.port';
import { PAYMENT_ORDER_REPOSITORY, type PaymentOrderRepositoryPort } from '../ports/payment-order-repository.port';
import { PAYMENT_REPOSITORY, type PaymentRepositoryPort } from '../ports/payment-repository.port';
import { WEBHOOK_EVENT_REPOSITORY, type WebhookEventRepositoryPort } from '../ports/webhook-event-repository.port';
import { TRANSACTION_RUNNER, type TransactionRunnerPort } from '../ports/transaction-runner.port';
import { heldCharge, RecordAuthorizationUseCase, type AuthorizationOutcome } from './record-authorization.use-case';

const COMPLETED = 'checkout.session.completed';
const EXPIRED = 'checkout.session.expired';

type ValidEvent = Extract<VerifiedEvent, { kind: 'valid' }>;

/** Never settles the order: only the saga moves it, off `payment.authorized`. */
export interface TccWebhookResult {
  path: 'tcc';
  outcome: 'duplicate' | 'skipped' | 'processed';
  reason?: 'awaiting_payment' | 'already_recorded' | 'amount_mismatch' | 'stray_voided' | 'already_settled';
  orderId: string;
  providerEventId: string;
  eventType: string;
}

type Applied = Pick<TccWebhookResult, 'outcome' | 'reason'>;

/**
 * The webhook for payments opened through the participant. It asks Stripe before writing (under
 * manual capture only the intent shows the hold), so the round-trip and every mint happen first and
 * the transaction only logs the event and applies.
 */
@Injectable()
export class ProcessTccWebhookEventUseCase {
  constructor(
    @Inject(TRANSACTION_RUNNER) private readonly transactionRunner: TransactionRunnerPort,
    @Inject(PAYMENT_ORDER_REPOSITORY) private readonly headers: PaymentOrderRepositoryPort,
    @Inject(PAYMENT_REPOSITORY) private readonly payments: PaymentRepositoryPort,
    @Inject(WEBHOOK_EVENT_REPOSITORY) private readonly webhookEvents: WebhookEventRepositoryPort,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGatewayPort,
    private readonly recordAuthorization: RecordAuthorizationUseCase,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGeneratorPort,
  ) {}

  /** Null when the event is not about a participant payment. */
  async execute(event: ValidEvent): Promise<TccWebhookResult | null> {
    if (event.type !== COMPLETED && event.type !== EXPIRED) return null;
    const { sessionId } = readCheckoutSession(event.payload);
    const payment = sessionId ? await this.payments.findByProviderSessionId(sessionId) : null;
    if (!payment || !(await this.headers.find(payment.orderId))) return null;

    const result = {
      path: 'tcc',
      orderId: payment.orderId,
      providerEventId: event.providerEventId,
      eventType: event.type,
    } as const;
    const applied =
      event.type === COMPLETED ? await this.completed(event, payment) : await this.expired(event, payment);
    return { ...result, ...applied };
  }

  private async completed(event: ValidEvent, payment: Payment): Promise<Applied> {
    // A failure here leaves no webhook_events row, so Stripe's redelivery gets a clean run.
    const authorization = await this.gateway.retrieveAuthorization(payment.providerSessionId);
    const hold = heldCharge(authorization);
    if (!hold) {
      return this.logged(event, await mintOne(this.idGenerator), () =>
        Promise.resolve({ outcome: 'skipped', reason: 'awaiting_payment' }),
      );
    }

    try {
      const prepared = await this.recordAuthorization.prepare(payment, hold, new Date());
      const eventId = await mintOne(this.idGenerator);
      // Counted after commit, and not at all for a duplicate delivery.
      let recorded: AuthorizationOutcome | undefined;
      const applied = await this.logged(event, eventId, async (tx) => {
        recorded = await this.recordAuthorization.apply(tx, prepared);
        return recorded === 'recorded' || recorded === 'recorded_late'
          ? { outcome: 'processed' }
          : { outcome: 'skipped', reason: recorded };
      });
      if (recorded) this.recordAuthorization.count(recorded);
      return applied;
    } catch (error) {
      this.recordAuthorization.count('error');
      throw error;
    }
  }

  private async expired(event: ValidEvent, payment: Payment): Promise<Applied> {
    const eventId = await mintOne(this.idGenerator);
    return this.logged(event, eventId, async (tx) => {
      await this.headers.findForUpdate(tx, payment.orderId);
      await this.payments.findByProviderSessionId(payment.providerSessionId, tx);
      const expired = await this.payments.updateStatus(payment.id as string, PaymentStatus.EXPIRED, {
        expectedStatus: PaymentStatus.PENDING,
        tx,
      });
      return expired ? { outcome: 'processed' } : { outcome: 'skipped', reason: 'already_settled' };
    });
  }

  /** Logs the event and applies it in one transaction; a duplicate delivery applies nothing. */
  private logged(event: ValidEvent, eventId: string, apply: (tx: DrizzleTx) => Promise<Applied>): Promise<Applied> {
    return this.transactionRunner.run(async (tx) => {
      const { inserted } = await this.webhookEvents.insertIfNew(
        {
          id: eventId,
          provider: this.gateway.provider,
          providerEventId: event.providerEventId,
          type: event.type,
          payload: event.payload,
        },
        tx,
      );
      if (!inserted) return { outcome: 'duplicate' };

      const applied = await apply(tx);
      if (applied.outcome === 'processed') {
        await this.webhookEvents.markProcessed(eventId, tx);
      } else {
        await this.webhookEvents.markSkipped(eventId, tx);
      }
      return applied;
    });
  }
}
