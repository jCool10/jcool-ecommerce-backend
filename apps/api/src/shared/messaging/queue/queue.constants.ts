import type { DefaultJobOptions } from 'bullmq';

/** One queue for every event type; splitting per type only pays off once one consumer starves another. */
export const QUEUE_DOMAIN_EVENTS = 'domain-events';

export const DOMAIN_EVENTS_QUEUE = Symbol('DOMAIN_EVENTS_QUEUE');

/**
 * Deliberately a queue with no worker: it holds poison out of the main queue's way and keeps it
 * visible, so jobs sit in `wait` until a human replays or drops them.
 */
export const QUEUE_DOMAIN_EVENTS_DLQ = 'domain-events-dlq';

export const DOMAIN_EVENTS_DLQ_QUEUE = Symbol('DOMAIN_EVENTS_DLQ_QUEUE');

/** A consumer GROUP, not a process: every instance of this worker dedups against the same inbox rows. */
export const DOMAIN_EVENTS_CONSUMER = 'domain-events';

/** Held separately because BullMQ never closes a client it was handed. */
export const QUEUE_CONNECTION = Symbol('QUEUE_CONNECTION');

/**
 * The longest a failed message can still be re-run. One half of a correctness pair: an inbox claim
 * must outlive its message, and `sweep-inbox.ts` asserts against this constant at boot.
 */
export const REMOVE_ON_FAIL_AGE_SEC = 604_800;

/** The same bound in the whole days `RETENTION_INBOX_DAYS` uses, derived so the pair cannot drift. */
export const MIN_INBOX_RETENTION_DAYS = Math.ceil(REMOVE_ON_FAIL_AGE_SEC / 86_400);

/**
 * A job's name is the outbox row's `event_type` verbatim, so a new event type needs no change here.
 * Retry is only safe because the inbox claim and the effect share one transaction.
 */
export function buildJobOptions(attempts: number, backoffMs: number): DefaultJobOptions {
  return {
    attempts,
    // `delay * 2^(n-1)` — 1s/2s/4s/8s at the defaults. BullMQ's exponential has no ceiling, so the
    // bound comes from capping `attempts`.
    backoff: { type: 'exponential', delay: backoffMs },
    // Bounded both ways — the outbox row is the durable record, these are only a debugging trail.
    removeOnComplete: { age: 3_600, count: 1_000 },
    // Kept even after the DLQ has its copy: that move is one more Redis write and can fail, and
    // BullMQ raises no `failed` for a job killed by the stalled-job limit.
    removeOnFail: { age: REMOVE_ON_FAIL_AGE_SEC, count: 10_000 },
  };
}
