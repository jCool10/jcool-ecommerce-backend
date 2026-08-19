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
}
