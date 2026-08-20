/**
 * Webhook-event lifecycle status. Const object + union type (not a TS enum); the string
 * values are identical to the `webhook_status` pg enum. RECEIVED on insert;
 * PROCESSED/SKIPPED/FAILED once the event is applied. Idempotency itself is enforced by
 * the unique (provider, provider_event_id) index, not by this status.
 */
export const WebhookEventStatus = {
  RECEIVED: 'RECEIVED',
  PROCESSED: 'PROCESSED',
  SKIPPED: 'SKIPPED',
  FAILED: 'FAILED',
} as const;

export type WebhookEventStatus = (typeof WebhookEventStatus)[keyof typeof WebhookEventStatus];

export const WEBHOOK_EVENT_STATUSES: readonly WebhookEventStatus[] = Object.values(WebhookEventStatus);
