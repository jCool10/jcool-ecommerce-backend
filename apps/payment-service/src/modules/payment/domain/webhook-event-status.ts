/**
 * A const object rather than a TS enum; the string values must stay identical to the `webhook_status`
 * pg enum. Idempotency is enforced by the unique (provider, provider_event_id) index, not by this
 * status.
 */
export const WebhookEventStatus = {
  RECEIVED: 'RECEIVED',
  PROCESSED: 'PROCESSED',
  SKIPPED: 'SKIPPED',
  FAILED: 'FAILED',
} as const;

export type WebhookEventStatus = (typeof WebhookEventStatus)[keyof typeof WebhookEventStatus];

export const WEBHOOK_EVENT_STATUSES: readonly WebhookEventStatus[] = Object.values(WebhookEventStatus);
