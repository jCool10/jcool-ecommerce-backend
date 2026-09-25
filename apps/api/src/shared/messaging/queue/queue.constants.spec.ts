import { afterEach, describe, expect, it, vi } from 'vitest';
import configuration from '@shared/config/configuration';
import {
  CATALOG_EVENT_PRIORITY,
  ORDER_PAID_BACKOFF,
  cappedBackoffMs,
  jobOptionsFor,
  retryHorizonMs,
} from './queue.constants';

const MINUTE_MS = 60_000;
const LADDER_ENV = [
  'QUEUE_CONSUMER_ATTEMPTS',
  'QUEUE_CONSUMER_BACKOFF_MS',
  'ORDER_PAID_CONSUMER_ATTEMPTS',
  'ORDER_PAID_CONSUMER_BACKOFF_CAP_MS',
];

describe('retry ladders', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('doubles from the base and stops at the cap', () => {
    expect([1, 2, 3, 4, 5].map((n) => cappedBackoffMs(n, 1_000, 5_000))).toEqual([1_000, 2_000, 4_000, 5_000, 5_000]);
  });

  // The README quotes both horizons; order.paid must ride out a user-service outage.
  it('rides out two minutes on the shared ladder and 30 on order.paid by default', () => {
    for (const key of LADDER_ENV) vi.stubEnv(key, '');
    const { queue } = configuration();

    const shared = retryHorizonMs(queue.consumerAttempts, (n) => queue.consumerBackoffMs * 2 ** (n - 1));
    const orderPaid = retryHorizonMs(queue.orderPaidAttempts, (n) =>
      cappedBackoffMs(n, queue.consumerBackoffMs, queue.orderPaidBackoffCapMs),
    );

    expect(shared).toBe(127_000);
    expect(orderPaid).toBeGreaterThanOrEqual(30 * MINUTE_MS);
    expect(orderPaid).toBeLessThan(40 * MINUTE_MS);
  });
});

describe('jobOptionsFor', () => {
  // BullMQ serves unprioritized jobs first, so only catalog work carries a priority.
  it('puts catalog events on the long ladder behind order and payment work', () => {
    expect(jobOptionsFor('catalog.product.changed', 15)).toEqual({
      attempts: 15,
      backoff: { type: ORDER_PAID_BACKOFF },
      priority: CATALOG_EVENT_PRIORITY,
    });
    expect(CATALOG_EVENT_PRIORITY).toBeGreaterThan(0);
  });

  it('keeps order.paid on the long ladder without a priority and every other event on the defaults', () => {
    expect(jobOptionsFor('order.paid', 15)).toEqual({ attempts: 15, backoff: { type: ORDER_PAID_BACKOFF } });
    expect(jobOptionsFor('order.placed', 15)).toEqual({});
  });
});
