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
  | { outcome: 'skipped'; reason: 'payment_not_found' | 'conflict' }
  // `orderId`/`paymentRef`/`eventType` let the caller finalize the order without re-reading the
  // payment: only `processed` settled it, so only `processed` carries what finalize needs.
  | { outcome: 'processed'; status: PaymentStatus; orderId: string; paymentRef: string | null; eventType: string };

/**
 * Verify a gateway webhook, then apply it exactly once.
 *
 * The idempotency insert and the payment change run in ONE transaction on purpose: if they were
 * separate, a crash after logging the event (RECEIVED) but before applying it would make the
 * gateway's redelivery see `inserted: false` and no-op forever — the effect lost. Atomic, a crash
 * rolls back the log too, so the retry re-does the whole unit. The DB unique(provider, eventId) is
 * the backstop that turns concurrent redeliveries into one winner + one no-op.
 *
 * This use case settles only the payment side (event log + Payment.status) inside that transaction.
 * Finalizing the Order (PENDING→PAID/FAILED) and resolving its held stock run after this commits, in
 * HandlePaymentWebhookUseCase via FinalizeOrderUseCase's own transaction — Payment and Order are
 * independent state machines.
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
      // Logged for audit, but not an outcome we act on this week — left RECEIVED.
      if (target === null) return { outcome: 'ignored' };

      const ref = extractPaymentRef(verified.payload);
      const payment = ref.sessionId ? await this.payments.findByProviderSessionId(ref.sessionId, tx) : null;
      // No matching payment yet (webhook raced ahead of the local commit, or an event shape we
      // don't link this week). Keep the audit row, skip applying — reconciliation is next week.
      if (!payment || payment.id === null) {
        await this.webhookEvents.markSkipped(eventId, tx);
        return { outcome: 'skipped', reason: 'payment_not_found' };
      }

      // Out-of-order or terminal-state event (e.g. a failure after success): reject the change in
      // the domain rather than clobbering a settled payment. The FOR UPDATE lock the read took
      // makes this guard hold under concurrent distinct events too; resolving what to DO about a
      // genuinely conflicting authentic event (refund/reconcile) is next week.
      if (!canTransition(payment.status, target)) {
        await this.webhookEvents.markSkipped(eventId, tx);
        return { outcome: 'skipped', reason: 'conflict' };
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
