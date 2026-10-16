import type { DefaultJobOptions } from 'bullmq';
import { MAX_REDELIVERY_AGE_SEC } from '../retry/retry-policy';

/** One queue for every event type; splitting per type only pays off once one consumer starves another. */
export const QUEUE_DOMAIN_EVENTS = 'domain-events';

export const DOMAIN_EVENTS_QUEUE = Symbol('DOMAIN_EVENTS_QUEUE');

/** A consumer GROUP, not a process: every instance of this worker dedups against the same inbox rows. */
export const DOMAIN_EVENTS_CONSUMER = 'domain-events';

/** Held separately because BullMQ never closes a client it was handed. */
export const QUEUE_CONNECTION = Symbol('QUEUE_CONNECTION');

/**
 * A job's name is the outbox row's `event_type` verbatim, so a new event type needs no change here.
 * Handler failures are retried from Postgres; this ladder only runs when the retry row itself could
 * not be written.
 */
export function buildJobOptions(attempts: number, backoffMs: number): DefaultJobOptions {
  return {
    attempts,
    backoff: { type: 'exponential', delay: backoffMs },
    // Bounded both ways — the outbox row is the durable record, these are only a debugging trail.
    removeOnComplete: { age: 3_600, count: 1_000 },
    removeOnFail: { age: MAX_REDELIVERY_AGE_SEC, count: 10_000 },
  };
}

/** Jobs already in Redis carry this custom backoff type, so the worker keeps a strategy for it. */
export const ORDER_PAID_BACKOFF = 'order-paid';

/** BullMQ serves every job without a priority first, so any value here yields to order and payment work. */
export const CATALOG_EVENT_PRIORITY = 10;
