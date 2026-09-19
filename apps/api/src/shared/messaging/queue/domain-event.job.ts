// The envelope on the wire: change a field here and the producer, the consumer, and every job
// already sitting in Redis are all affected.

export interface DomainEventJob {
  /** The outbox row id. Stable across redeliveries of the same event — the key a consumer dedups on. */
  outboxId: string;

  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt: string;
  traceparent: string | null;
}

/**
 * Work a handler wants done only once its transaction has committed — reaching something no
 * transaction can hold, like an SMTP server. Returned rather than run, so the handler cannot perform
 * it early by accident.
 */
export type PostCommitEffect = () => Promise<void>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The envelope arrives as JSON from Redis, so its declared type is a claim, not a guarantee. Called
 * wherever `outboxId` is about to be used as a key, so a bad value surfaces here rather than as a
 * Postgres cast error deep inside a transaction.
 */
export function isWellFormedEnvelope(job: DomainEventJob | undefined): boolean {
  return UUID.test(job?.outboxId ?? '') && Boolean(job?.eventType);
}

/** Field names only: the payload can carry customer data, and this string ends up in logs. */
export function envelopeFields(job: unknown): string {
  return Object.keys((job as Record<string, unknown> | null) ?? {}).join(',') || 'none';
}
