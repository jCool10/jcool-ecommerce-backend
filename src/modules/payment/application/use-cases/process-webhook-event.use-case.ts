import { Inject, Injectable } from '@nestjs/common';
import { OUTBOX_WRITER, type OutboxWriterPort } from '@shared/messaging/outbox/outbox-writer.port';
import { PaymentStatus } from '../../domain/payment-status';
import { canTransition } from '../../domain/payment-state-machine';
import { PAYMENT_GATEWAY, type PaymentGatewayPort } from '../ports/payment-gateway.port';
import { PAYMENT_REPOSITORY, type PaymentRepositoryPort } from '../ports/payment-repository.port';
import { WEBHOOK_EVENT_REPOSITORY, type WebhookEventRepositoryPort } from '../ports/webhook-event-repository.port';
import { TRANSACTION_RUNNER, type TransactionRunnerPort } from '../ports/transaction-runner.port';
import { chargeMatchesPayment } from '../mappers/charge-matches-payment';
import { mapEventToOutcome } from '../mappers/map-event-to-outcome';
import { readCheckoutSession } from '../mappers/read-checkout-session';
import { toSettledOutboxRecord } from '../payment-outbox.mapper';

/**
 * `rejected` is the only non-2xx result (verify failed, nothing persisted); every other outcome means
 * the event was accepted and logged, so the gateway gets a 2xx and stops retrying.
 */
export type WebhookProcessResult =
  | { outcome: 'rejected'; reason: 'invalid_signature' | 'expired_timestamp' }
  | { outcome: 'duplicate' }
  | { outcome: 'ignored' }
  // The reason separates the harmless (a late notice, a session still clearing) from the two that
  // need a human: a success landing on a payment we already closed, and a charge that isn't ours.
  | {
      outcome: 'skipped';
      reason: 'payment_not_found' | 'conflict' | 'awaiting_payment' | 'amount_mismatch';
      conflict?: { orderId: string; from: PaymentStatus; to: PaymentStatus };
      charge?: {
        orderId: string;
        expectedMinor: number;
        expectedCurrency: string;
        actualMinor?: number;
        actualCurrency?: string;
      };
    }
  | { outcome: 'processed'; status: PaymentStatus; orderId: string; paymentRef: string | null; eventType: string };

/**
 * Applies a verified webhook to the payment side only. The idempotency insert and the payment change
 * share ONE transaction: split them, and a crash after logging the event but before applying it leaves
 * the redelivery seeing `inserted: false` and no-oping forever.
 */
@Injectable()
export class ProcessWebhookEventUseCase {
  constructor(
    @Inject(TRANSACTION_RUNNER) private readonly txRunner: TransactionRunnerPort,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGatewayPort,
    @Inject(WEBHOOK_EVENT_REPOSITORY) private readonly webhookEvents: WebhookEventRepositoryPort,
    @Inject(PAYMENT_REPOSITORY) private readonly payments: PaymentRepositoryPort,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriterPort,
  ) {}

  async execute(rawBody: Buffer, headers: Record<string, string>): Promise<WebhookProcessResult> {
    // Verify BEFORE any DB write — a forged or replayed body must never reach the event log.
    const verified = this.gateway.verifyAndParseEvent(rawBody, headers);
    if (verified.kind !== 'valid') {
      return { outcome: 'rejected', reason: verified.kind };
    }

    return this.txRunner.run(async (tx) => {
      const { inserted, event } = await this.webhookEvents.insertIfNew(
        {
          provider: this.gateway.provider,
          providerEventId: verified.providerEventId,
          type: verified.type,
          payload: verified.payload,
        },
        tx,
      );
      if (!inserted) return { outcome: 'duplicate' };

      const eventId = event.id;
      if (eventId === null) throw new Error('inserted webhook_events row has no id');

      const facts = readCheckoutSession(verified.payload);
      const settlement = mapEventToOutcome(verified.type, facts.paymentStatus);
      // Left RECEIVED, not skipped: logged for audit, never a candidate for application.
      if (settlement.kind === 'ignore') return { outcome: 'ignored' };

      // The session finished but the money has not cleared. Leaving the payment PENDING is the whole
      // point: the sweep settles it once the gateway reports it paid, and never before.
      if (settlement.kind === 'awaiting_payment') {
        await this.webhookEvents.markSkipped(eventId, tx);
        return { outcome: 'skipped', reason: 'awaiting_payment' };
      }

      const target = settlement.status;
      const payment = facts.sessionId ? await this.payments.findByProviderSessionId(facts.sessionId, tx) : null;
      // The webhook raced ahead of our own commit, or carries a shape we don't link to a payment.
      // Keep the audit row and skip applying; the sweep settles the order either way.
      if (!payment || payment.id === null) {
        await this.webhookEvents.markSkipped(eventId, tx);
        return { outcome: 'skipped', reason: 'payment_not_found' };
      }

      // Only a success moves money, so only a success has to prove it moved OUR money.
      if (target === PaymentStatus.SUCCEEDED && !chargeMatchesPayment(payment, facts)) {
        await this.webhookEvents.markSkipped(eventId, tx);
        return {
          outcome: 'skipped',
          reason: 'amount_mismatch',
          charge: {
            orderId: payment.orderId,
            expectedMinor: payment.amountMinor,
            expectedCurrency: payment.currency,
            actualMinor: facts.amountMinor,
            actualCurrency: facts.currency,
          },
        };
      }

      // Out-of-order or terminal-state event: refuse it in the domain rather than clobber a settled
      // payment. The read's FOR UPDATE lock makes the guard hold under concurrent distinct events.
      if (!canTransition(payment.status, target)) {
        await this.webhookEvents.markSkipped(eventId, tx);
        return {
          outcome: 'skipped',
          reason: 'conflict',
          conflict: { orderId: payment.orderId, from: payment.status, to: target },
        };
      }

      const applied =
        target === PaymentStatus.SUCCEEDED ? payment.markSucceeded(facts.intentId) : payment.markFailed(facts.intentId);
      const updated = await this.payments.updateStatus(payment.id, applied.status, {
        providerIntentId: applied.providerIntentId,
        tx,
      });
      // The row was just read+locked in this tx, so a null update is an invariant break, not a
      // missing payment — throw to roll the whole unit back rather than falsely mark it PROCESSED.
      if (!updated) throw new Error(`payment vanished mid-transaction: ${payment.id}`);
      await this.webhookEvents.markProcessed(eventId, tx);

      // Same tx as the settlement, so a settled payment can never lose the event that drives its order
      // — the crash window the direct call in HandlePaymentWebhookUseCase cannot close, since that one
      // runs after this commit. It publishes what happened to the money, not what the order becomes.
      await this.outbox.append(
        tx,
        toSettledOutboxRecord({
          paymentId: payment.id,
          orderId: payment.orderId,
          status: target,
          paymentRef: applied.providerIntentId,
          settledAt: new Date(),
        }),
      );

      return {
        outcome: 'processed',
        status: applied.status,
        orderId: payment.orderId,
        paymentRef: applied.providerIntentId,
        eventType: verified.type,
      };
    });
  }
}
