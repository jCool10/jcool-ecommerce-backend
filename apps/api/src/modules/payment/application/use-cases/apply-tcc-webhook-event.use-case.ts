import { Inject, Injectable } from '@nestjs/common';
import { ID_GENERATOR, mintOne, type IdGeneratorPort } from '@shared/identity/id-generator.port';
import type { DrizzleTx } from '@shared/infrastructure/database';
import { PaymentStatus } from '../../domain/payment-status';
import type { Payment } from '../../domain/payment.entity';
import {
  PAYMENT_GATEWAY,
  PaymentGatewayError,
  type PaymentGatewayPort,
  type SessionAuthorization,
  type VerifiedEvent,
} from '../ports/payment-gateway.port';
import { PAYMENT_REPOSITORY, type PaymentRepositoryPort } from '../ports/payment-repository.port';
import { TRANSACTION_RUNNER, type TransactionRunnerPort } from '../ports/transaction-runner.port';
import { WEBHOOK_EVENT_REPOSITORY, type WebhookEventRepositoryPort } from '../ports/webhook-event-repository.port';
import { RecordAuthorizationUseCase, type RecordAuthorizationResult } from './record-authorization.use-case';
import type { WebhookProcessResult, WebhookSkipReason } from './webhook-process-result';

type ValidEvent = Extract<VerifiedEvent, { kind: 'valid' }>;

const SKIP_REASON: Record<Extract<RecordAuthorizationResult, { outcome: 'skipped' }>['reason'], WebhookSkipReason> = {
  not_authorized: 'awaiting_payment',
  payment_not_found: 'payment_not_found',
  already_recorded: 'already_settled',
  conflict: 'conflict',
  amount_mismatch: 'amount_mismatch',
};

/**
 * Session events for a payment opened behind a header. Stripe only places a hold here, so nothing is
 * settled and no order is moved: the hold is recorded and announced, and the saga decides the rest.
 */
@Injectable()
export class ApplyTccWebhookEventUseCase {
  constructor(
    @Inject(TRANSACTION_RUNNER) private readonly txRunner: TransactionRunnerPort,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGatewayPort,
    @Inject(WEBHOOK_EVENT_REPOSITORY) private readonly webhookEvents: WebhookEventRepositoryPort,
    @Inject(PAYMENT_REPOSITORY) private readonly payments: PaymentRepositoryPort,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGeneratorPort,
    private readonly recordAuthorization: RecordAuthorizationUseCase,
  ) {}

  /** `payment` is the caller's unlocked read; everything decided from it is re-checked under lock. */
  execute(event: ValidEvent, payment: Payment): Promise<WebhookProcessResult> {
    return event.type === 'checkout.session.completed' ? this.recordHold(event, payment) : this.expire(event, payment);
  }

  private async recordHold(event: ValidEvent, payment: Payment): Promise<WebhookProcessResult> {
    const delivery = { providerEventId: event.providerEventId, eventType: event.type };
    let authorization: SessionAuthorization;
    try {
      authorization = await this.gateway.retrieveAuthorization(payment.providerSessionId);
    } catch (error) {
      if (error instanceof PaymentGatewayError) return { outcome: 'unavailable', ...delivery };
      throw error;
    }
    const [eventId, outboxId] = await this.idGenerator.mint(2);

    return this.txRunner.run(async (tx) => {
      if (!(await this.logDelivery(event, tx, eventId))) return { outcome: 'duplicate', ...delivery };

      const recorded = await this.recordAuthorization.execute(tx, {
        orderId: payment.orderId,
        providerSessionId: payment.providerSessionId,
        authorization,
        authorizedAt: new Date(),
        outboxId,
      });
      if (recorded.outcome === 'skipped') {
        await this.webhookEvents.markSkipped(eventId, tx);
        return { outcome: 'skipped', reason: SKIP_REASON[recorded.reason], ...delivery };
      }
      await this.webhookEvents.markProcessed(eventId, tx);
      return {
        outcome: 'processed',
        status: PaymentStatus.AUTHORIZED,
        orderId: payment.orderId,
        paymentRef: authorization.intentId ?? null,
        eventType: event.type,
      };
    });
  }

  // Touches the payment row alone, so it needs no header lock to keep the lock order.
  private async expire(event: ValidEvent, payment: Payment): Promise<WebhookProcessResult> {
    const delivery = { providerEventId: event.providerEventId, eventType: event.type };
    const eventId = await mintOne(this.idGenerator);

    return this.txRunner.run(async (tx) => {
      if (!(await this.logDelivery(event, tx, eventId))) return { outcome: 'duplicate', ...delivery };

      const locked = await this.payments.findByProviderSessionId(payment.providerSessionId, tx);
      if (locked?.status !== PaymentStatus.PENDING) {
        await this.webhookEvents.markSkipped(eventId, tx);
        return { outcome: 'skipped', reason: locked === null ? 'payment_not_found' : 'already_settled', ...delivery };
      }
      await this.payments.updateStatus(locked.id as string, locked.markExpired().status, {
        tx,
        expectedStatus: PaymentStatus.PENDING,
      });
      await this.webhookEvents.markProcessed(eventId, tx);
      return {
        outcome: 'processed',
        status: PaymentStatus.EXPIRED,
        orderId: locked.orderId,
        paymentRef: locked.providerIntentId,
        eventType: event.type,
      };
    });
  }

  private async logDelivery(event: ValidEvent, tx: DrizzleTx, id: string): Promise<boolean> {
    const { inserted } = await this.webhookEvents.insertIfNew(
      {
        provider: this.gateway.provider,
        providerEventId: event.providerEventId,
        type: event.type,
        payload: event.payload,
      },
      tx,
      id,
    );
    return inserted;
  }
}
