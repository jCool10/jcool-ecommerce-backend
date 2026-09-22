import { describe, expect, it } from 'vitest';
import { ORDER_PAID_BACKOFF, cappedBackoffMs, jobOptionsFor, retryHorizonMs } from './queue.constants';

const MINUTE_MS = 60_000;

describe('retry ladders', () => {
  it('doubles from the base and stops at the cap', () => {
    expect([1, 2, 3, 4, 5].map((n) => cappedBackoffMs(n, 1_000, 5_000))).toEqual([1_000, 2_000, 4_000, 5_000, 5_000]);
  });

  it('gives the shared ladder about two minutes at the defaults', () => {
    expect(retryHorizonMs(8, (n) => 1_000 * 2 ** (n - 1))).toBe(127_000);
  });

  // The user-service outage order.paid must ride out before its buyer loses the confirmation.
  it('gives order.paid at least thirty minutes at the defaults', () => {
    const horizon = retryHorizonMs(15, (n) => cappedBackoffMs(n, 1_000, 5 * MINUTE_MS));

    expect(horizon).toBeGreaterThanOrEqual(30 * MINUTE_MS);
    expect(horizon).toBeLessThan(40 * MINUTE_MS);
  });

  it('publishes order.paid on its own ladder and everything else on the queue defaults', () => {
    expect(jobOptionsFor('order.paid', 15)).toEqual({ attempts: 15, backoff: { type: ORDER_PAID_BACKOFF } });
    expect(jobOptionsFor('order.placed', 15)).toEqual({});
  });
});
