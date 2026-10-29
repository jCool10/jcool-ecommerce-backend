import type { DefaultJobOptions } from 'bullmq';

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
    // Kept even after the DLQ has its copy: that move is one more Redis write and can fail.
    removeOnFail: { age: REMOVE_ON_FAIL_AGE_SEC, count: 10_000 },
  };
}

/** Exponential with a ceiling: past a few minutes, doubling only thins the attempts out. */
export function cappedBackoffMs(attemptsMade: number, baseMs: number, capMs: number): number {
  return Math.min(capMs, baseMs * 2 ** (attemptsMade - 1));
}

/** The longest outage a ladder rides out: every wait before the last attempt. */
export function retryHorizonMs(attempts: number, delayAfter: (attemptsMade: number) => number): number {
  let total = 0;
  for (let attemptsMade = 1; attemptsMade < attempts; attemptsMade++) total += delayAfter(attemptsMade);
  return total;
}
