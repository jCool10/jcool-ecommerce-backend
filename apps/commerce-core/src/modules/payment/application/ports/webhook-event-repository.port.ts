import type { DrizzleTx } from '@shared/infrastructure/database';
import type { WebhookEvent } from '../../domain/webhook-event.entity';

export const WEBHOOK_EVENT_REPOSITORY = Symbol('WEBHOOK_EVENT_REPOSITORY');

export interface NewWebhookEvent {
  provider: string;
  providerEventId: string;
  type: string;
  payload: unknown;
}

export interface InsertWebhookEventResult {
  /** false = the same (provider, providerEventId) already existed and `event` is that stored row. */
  inserted: boolean;
  event: WebhookEvent;
}

export interface WebhookEventRepositoryPort {
  /**
   * ON CONFLICT DO NOTHING on the unique (provider, providerEventId): a duplicate delivery returns
   * the existing row instead of throwing, so a concurrent redelivery cannot double-apply.
   */
  insertIfNew(input: NewWebhookEvent, tx?: DrizzleTx): Promise<InsertWebhookEventResult>;

  /**
   * Must be called in the SAME transaction as the payment status change, so "applied but not marked
   * processed" cannot survive a crash.
   */
  markProcessed(id: string, tx?: DrizzleTx): Promise<void>;

  /**
   * SKIPPED means the event verified and was logged, but no payment change applied (out-of-order or
   * terminal-state conflict, or the payment isn't visible yet). Distinct from PROCESSED so the log
   * shows the event was consciously not acted on, not lost.
   */
  markSkipped(id: string, tx?: DrizzleTx): Promise<void>;

  /**
   * Age is the only legal deletion condition. Status is not: a RECEIVED row inside the gateway's
   * redelivery window is what makes a repeated delivery a no-op, and collecting it early would let
   * the same event be applied a second time.
   */
  deleteReceivedBefore(cutoff: Date, limit: number): Promise<number>;
}
