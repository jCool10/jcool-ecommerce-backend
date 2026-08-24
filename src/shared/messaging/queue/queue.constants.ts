import type { DefaultJobOptions } from 'bullmq';

// Queue/job names and DI tokens in one place so the providers, the relay, the worker, and the
// tests never drift on a string — the same reasoning as metric-definitions.ts.

/** One queue for every event type; splitting per type only pays off once one consumer starves another. */
export const QUEUE_DOMAIN_EVENTS = 'domain-events';

export const DOMAIN_EVENTS_QUEUE = Symbol('DOMAIN_EVENTS_QUEUE');

/** Held separately because BullMQ never closes a client it was handed. */
export const QUEUE_CONNECTION = Symbol('QUEUE_CONNECTION');

/** A job's name is the outbox row's `event_type` verbatim, so a new event type needs no change here. */
export const DEFAULT_JOB_OPTIONS: DefaultJobOptions = {
  // Bounded both ways — the outbox row is the durable record, these are only a debugging trail.
  removeOnComplete: { age: 3_600, count: 1_000 },
  removeOnFail: { age: 604_800, count: 10_000 },
  // No `attempts`/`backoff` yet, so a throwing consumer fails on its first try. The relay cannot
  // rescue it (the row is already published by then) — which is why retry and a dead-letter queue
  // have to arrive together with the consumer.
};
