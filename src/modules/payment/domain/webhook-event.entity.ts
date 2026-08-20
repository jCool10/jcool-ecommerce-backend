import { assertNonEmpty } from '@shared/kernel';
import { WebhookEventStatus } from './webhook-event-status';

/**
 * Webhook event — the domain view of one gateway delivery. Pure: no framework/DB
 * imports. The verified `payload` is kept for audit/reconcile. Uniqueness by
 * (provider, providerEventId) is a persistence concern (the unique index); this entity
 * only models the event and its processing status. `id`/`receivedAt` are null before
 * persistence, set once rehydrated from a row.
 */
export class WebhookEvent {
  private constructor(
    public readonly id: string | null,
    public readonly provider: string,
    public readonly providerEventId: string,
    public readonly type: string,
    public readonly payload: unknown,
    public readonly status: WebhookEventStatus,
    public readonly receivedAt: Date | null,
    public readonly processedAt: Date | null,
  ) {}

  /** A newly received event (id/receivedAt assigned on insert). */
  static create(props: { provider: string; providerEventId: string; type: string; payload: unknown }): WebhookEvent {
    assertNonEmpty(props.provider, 'WebhookEvent.provider');
    assertNonEmpty(props.providerEventId, 'WebhookEvent.providerEventId');
    assertNonEmpty(props.type, 'WebhookEvent.type');
    return new WebhookEvent(
      null,
      props.provider,
      props.providerEventId,
      props.type,
      props.payload,
      WebhookEventStatus.RECEIVED,
      null,
      null,
    );
  }

  /** Reconstruct from persisted state (repository use only). */
  static rehydrate(props: {
    id: string;
    provider: string;
    providerEventId: string;
    type: string;
    payload: unknown;
    status: WebhookEventStatus;
    receivedAt: Date;
    processedAt: Date | null;
  }): WebhookEvent {
    return new WebhookEvent(
      props.id,
      props.provider,
      props.providerEventId,
      props.type,
      props.payload,
      props.status,
      props.receivedAt,
      props.processedAt,
    );
  }
}
