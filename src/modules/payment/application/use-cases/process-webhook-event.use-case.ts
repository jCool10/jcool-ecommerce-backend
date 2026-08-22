import { Inject, Injectable } from '@nestjs/common';
import { PaymentStatus } from '../../domain/payment-status';
import { canTransition } from '../../domain/payment-state-machine';
import { PAYMENT_GATEWAY, type PaymentGatewayPort } from '../ports/payment-gateway.port';
import { PAYMENT_REPOSITORY, type PaymentRepositoryPort } from '../ports/payment-repository.port';
import { WEBHOOK_EVENT_REPOSITORY, type WebhookEventRepositoryPort } from '../ports/webhook-event-repository.port';
import { TRANSACTION_RUNNER, type TransactionRunnerPort } from '../ports/transaction-runner.port';
import { mapEventType } from '../mappers/map-event-type';

/**
 * Outcome of one webhook delivery. `rejected` is the only non-2xx result (verify failed, nothing
 * persisted); every other outcome means the event was accepted and logged, so the gateway gets a
 * 2xx and stops retrying.
 */
export type WebhookProcessResult =
  | { outcome: 'rejected'; reason: 'invalid_signature' | 'expired_timestamp' }
  | { outcome: 'duplicate' }
  | { outcome: 'ignored' }
  // `conflict` separates a harmless late notice from a success landing on a payment we already closed.
  | {
      outcome: 'skipped';
      reason: 'payment_not_found' | 'conflict';
      conflict?: { orderId: string; from: PaymentStatus; to: PaymentStatus };
    }
  // Only `processed` settled the payment, so only it carries what the caller needs to finalize.
  | { outcome: 'processed'; status: PaymentStatus; orderId: string; paymentRef: string | null; eventType: string };

/**
 * Verify a gateway webhook, then apply it exactly once to the payment side only.
 *
 * The idempotency insert and the payment change share ONE transaction: split them, and a crash after
 * logging the event but before applying it leaves the redelivery seeing `inserted: false` and
 * no-oping forever. The DB unique(provider, eventId) turns concurrent redeliveries into one winner.
 */
@Injectable()
export class ProcessWebhookEventUseCase {
  constructor(
    @Inject(TRANSACTION_RUNNER) private readonly txRunner: TransactionRunnerPort,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGatewayPort,
    @Inject(WEBHOOK_EVENT_REPOSITORY) private readonly webhookEvents: WebhookEventRepositoryPort,
    @Inject(PAYMENT_REPOSITORY) private readonly payments: PaymentRepositoryPort,
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
      // Already logged by a prior (or racing) delivery — do not apply a second time.
      if (!inserted) return { outcome: 'duplicate' };

      const eventId = event.id;
      if (eventId === null) throw new Error('inserted webhook_events row has no id');

      const target = mapEventType(verified.type);
      // An event type we log for audit but do not act on — left RECEIVED.
      if (target === null) return { outcome: 'ignored' };

      const ref = extractPaymentRef(verified.payload);
      const payment = ref.sessionId ? await this.payments.findByProviderSessionId(ref.sessionId, tx) : null;
      // The webhook raced ahead of our own commit, or carries a shape we don't link to a payment.
      // Keep the audit row and skip applying; the sweep settles the order either way.
      if (!payment || payment.id === null) {
        await this.webhookEvents.markSkipped(eventId, tx);
        return { outcome: 'skipped', reason: 'payment_not_found' };
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
        target === PaymentStatus.SUCCEEDED ? payment.markSucceeded(ref.intentId) : payment.markFailed(ref.intentId);
      const updated = await this.payments.updateStatus(payment.id, applied.status, {
        providerIntentId: applied.providerIntentId,
        tx,
      });
      // The row was just read+locked in this tx, so a null update is an invariant break, not a
      // missing payment — throw to roll the whole unit back rather than falsely mark it PROCESSED.
      if (!updated) throw new Error(`payment vanished mid-transaction: ${payment.id}`);
      await this.webhookEvents.markProcessed(eventId, tx);

      // The payment is settled in this tx; finalizing the Order (PENDING→PAID/FAILED) + resolving
      // held stock runs AFTER this tx commits, in FinalizeOrderUseCase's own tx (see
      // HandlePaymentWebhookUseCase). Kept separate so Payment and Order stay independent state
      // machines; a finalize that fails post-commit is closed by the reconciliation cron.
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

/**
 * Pull the payment handles out of a verified Stripe-style event body. Reads `data.object.id`
 * (the session handle persisted on Payment.providerSessionId) and, when present,
 * `data.object.payment_intent` (recorded on success to link session → intent). Fully defensive:
 * the body is authenticated but its inner shape is the sender's, so a missing field just yields
 * undefined and the caller skips rather than throwing.
 */
function extractPaymentRef(payload: unknown): { sessionId?: string; intentId?: string } {
  const object = asRecord(asRecord(payload)?.data)?.object;
  const record = asRecord(object);
  const sessionId = typeof record?.id === 'string' ? record.id : undefined;
  const intentId = typeof record?.payment_intent === 'string' ? record.payment_intent : undefined;
  return { sessionId, intentId };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}
