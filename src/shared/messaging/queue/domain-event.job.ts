// The envelope on the wire between the relay and the worker. It lives beside the queue rather than
// with either half because both sides have to agree on it: change a field here and the producer,
// the consumer, and every job already sitting in Redis are all affected.

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
