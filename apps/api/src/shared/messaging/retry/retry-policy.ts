import type { ConfigService } from '@nestjs/config';

/**
 * The longest a delivered message can still come back: BullMQ keeps a failed job this long, and a
 * Kafka topic keeps a record as long, plus up to the broker's 5-minute retention check
 * (kafka-topology.ts). One half of a correctness pair — an inbox claim must outlive it, and
 * `sweep-inbox.ts` asserts that at boot.
 */
export const MAX_REDELIVERY_AGE_SEC = 604_800;

export const MIN_INBOX_RETENTION_DAYS = Math.ceil(MAX_REDELIVERY_AGE_SEC / 86_400);

export interface RetryLadderConfig {
  consumerAttempts: number;
  consumerBackoffMs: number;
  orderPaidAttempts: number;
  orderPaidBackoffCapMs: number;
}

export interface RetryPolicy {
  /** Deliveries before the message is dead-lettered, the first included. */
  attempts: number;
  /** Wait before the next attempt, once `attemptsMade` attempts have failed. */
  delayAfter(attemptsMade: number): number;
}

// These wait on something outside the database: the user-service for the buyer's address, the search
// engine, or Stripe closing a checkout session. The long ladder has to outlast that session's own
// lifetime, or a dead-lettered close leaves a payable page on stock that was already released.
const LONG_LADDER_EVENTS = new Set(['order.paid', 'order.expired', 'order.cancelled']);

export function retryPolicyFor(eventType: string, ladder: RetryLadderConfig): RetryPolicy {
  if (LONG_LADDER_EVENTS.has(eventType) || eventType.startsWith('catalog.')) {
    return {
      attempts: ladder.orderPaidAttempts,
      delayAfter: (n) => cappedBackoffMs(n, ladder.consumerBackoffMs, ladder.orderPaidBackoffCapMs),
    };
  }
  return { attempts: ladder.consumerAttempts, delayAfter: (n) => ladder.consumerBackoffMs * 2 ** (n - 1) };
}

export function retryLadderFrom(config: ConfigService): RetryLadderConfig {
  return {
    consumerAttempts: config.getOrThrow<number>('queue.consumerAttempts'),
    consumerBackoffMs: config.getOrThrow<number>('queue.consumerBackoffMs'),
    orderPaidAttempts: config.getOrThrow<number>('queue.orderPaidAttempts'),
    orderPaidBackoffCapMs: config.getOrThrow<number>('queue.orderPaidBackoffCapMs'),
  };
}

export function cappedBackoffMs(attemptsMade: number, baseMs: number, capMs: number): number {
  return Math.min(capMs, baseMs * 2 ** (attemptsMade - 1));
}

/** The longest outage a ladder rides out: every wait before the last attempt. */
export function retryHorizonMs(attempts: number, delayAfter: (attemptsMade: number) => number): number {
  let total = 0;
  for (let attemptsMade = 1; attemptsMade < attempts; attemptsMade++) total += delayAfter(attemptsMade);
  return total;
}
