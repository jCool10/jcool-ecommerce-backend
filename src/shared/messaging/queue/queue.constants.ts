import type { DefaultJobOptions } from 'bullmq';

// Queue/job names and DI tokens in one place so the providers, the relay, the worker, and the
// tests never drift on a string — the same reasoning as metric-definitions.ts.

/** One queue for every event type; splitting per type only pays off once one consumer starves another. */
export const QUEUE_DOMAIN_EVENTS = 'domain-events';

export const DOMAIN_EVENTS_QUEUE = Symbol('DOMAIN_EVENTS_QUEUE');

/**
 * Where a message goes once retrying it has stopped being useful. Deliberately a queue with no
 * worker: its job is to hold poison out of the main queue's way and keep it visible, not to run it.
 * Jobs sit in `wait` until a human replays or drops them.
 */
export const QUEUE_DOMAIN_EVENTS_DLQ = 'domain-events-dlq';

export const DOMAIN_EVENTS_DLQ_QUEUE = Symbol('DOMAIN_EVENTS_DLQ_QUEUE');

/**
 * Who the inbox dedups on behalf of. A consumer GROUP, not a process: every instance of this worker
 * shares the value so they collapse each other's duplicates, while a second consumer that needs the
 * same events for its own purpose gets its own identity and its own rows.
 */
export const DOMAIN_EVENTS_CONSUMER = 'domain-events';

/** Held separately because BullMQ never closes a client it was handed. */
export const QUEUE_CONNECTION = Symbol('QUEUE_CONNECTION');

/**
 * Retry policy for `domain-events`. A job's name is the outbox row's `event_type` verbatim, so a
 * new event type needs no change here.
 *
 * Retry is only safe because the consumer is idempotent: the inbox claim and the effect share one
 * transaction, so a failed attempt leaves nothing behind and the next one does the work for real.
 * Turning `attempts` up without that would just multiply the effect.
 */
export function buildJobOptions(attempts: number, backoffMs: number): DefaultJobOptions {
  return {
    attempts,
    // `delay * 2^(n-1)` — at the defaults, 1s/2s/4s/8s between five tries. BullMQ's exponential has
    // no ceiling of its own, so the bound comes from capping `attempts` instead (ten tries would
    // already stretch the last wait past eight minutes).
    backoff: { type: 'exponential', delay: backoffMs },
    // Bounded both ways — the outbox row is the durable record, these are only a debugging trail.
    removeOnComplete: { age: 3_600, count: 1_000 },
    // Kept even after the dead-letter queue has its copy: that move is one more Redis write and can
    // itself fail, and BullMQ does not raise `failed` for a job killed by the stalled-job limit. In
    // both cases this set is the only remaining record of the message.
    removeOnFail: { age: 604_800, count: 10_000 },
  };
}
