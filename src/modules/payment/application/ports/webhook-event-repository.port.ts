import type { DrizzleTx } from '@shared/infrastructure/database';
import type { WebhookEvent } from '../../domain/webhook-event.entity';

// Webhook-event persistence port; the Drizzle adapter implements it in infrastructure/.
export const WEBHOOK_EVENT_REPOSITORY = Symbol('WEBHOOK_EVENT_REPOSITORY');

export interface NewWebhookEvent {
  provider: string;
  providerEventId: string;
  type: string;
  payload: unknown;
}

export interface InsertWebhookEventResult {
  /**
   * false = an event with the same (provider, providerEventId) already existed; `event`
   * is the stored row, untouched — the idempotency branch point for the webhook handler.
   */
  inserted: boolean;
  event: WebhookEvent;
}

export interface WebhookEventRepositoryPort {
  /**
   * Insert-if-new via ON CONFLICT DO NOTHING on the unique (provider, providerEventId). A
   * duplicate delivery returns `inserted: false` with the existing row instead of throwing,
   * so a concurrent redelivery cannot double-apply.
   */
  insertIfNew(input: NewWebhookEvent, tx?: DrizzleTx): Promise<InsertWebhookEventResult>;

  /**
   * Mark a received event PROCESSED and stamp processedAt. Called in the SAME transaction as the
   * payment status change, so "applied but not marked processed" cannot survive a crash.
   */
  markProcessed(id: string, tx?: DrizzleTx): Promise<void>;

  /**
   * Mark a received event SKIPPED: it verified and was logged for audit, but no payment change
   * applied (out-of-order/terminal-state conflict, or the payment isn't visible yet — the T7
   * reconciliation seam). Distinct from PROCESSED so the log shows the event was consciously not
   * acted on, not lost.
   */
  markSkipped(id: string, tx?: DrizzleTx): Promise<void>;

  /**
   * DELETE WHERE received_at < cutoff, at most `limit` rows (retention sweep). Returns how many
   * were reclaimed.
   *
   * Age is the only legal condition. Status is not: a RECEIVED row inside the gateway's redelivery
   * window is what makes a repeated delivery a no-op, and collecting it early would let the same
   * event be applied a second time.
   */
  deleteReceivedBefore(cutoff: Date, limit: number): Promise<number>;
}
