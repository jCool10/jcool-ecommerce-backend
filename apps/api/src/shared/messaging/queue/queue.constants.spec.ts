import { afterEach, describe, expect, it, vi } from 'vitest';
import configuration from '@shared/config/configuration';
import {
  EXPIRY_CLOCK_MARGIN_SEC,
  SESSION_LIFETIME_SEC,
} from '@modules/payment/infrastructure/gateway/stripe-gateway.adapter';
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

  // order.expired/order.cancelled ride the same ladder as order.paid, and this is the property that
  // fix depends on: a Checkout Session that outlives every retry must still die at Stripe's own clock
  // before this ladder gives up, or a dead-lettered close leaves a payable page on released stock.
  it('outlasts a Checkout Session lifetime, with margin, on the ladder order.expired and order.cancelled share with order.paid', () => {
    for (const key of LADDER_ENV) vi.stubEnv(key, '');
    const { queue } = configuration();

    const horizon = retryHorizonMs(queue.orderPaidAttempts, (n) =>
      cappedBackoffMs(n, queue.consumerBackoffMs, queue.orderPaidBackoffCapMs),
    );
    const sessionLifetimeMs = (SESSION_LIFETIME_SEC + EXPIRY_CLOCK_MARGIN_SEC) * 1000;

    expect(horizon).toBeGreaterThan(sessionLifetimeMs);
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

  // The dead-letter fix: these two used to fall through to the short shared ladder (~2 minutes),
  // dead-lettering long before a Stripe Checkout Session dies on its own.
  it('gives order.expired and order.cancelled the same long ladder as order.paid', () => {
    expect(jobOptionsFor('order.expired', 15)).toEqual({ attempts: 15, backoff: { type: ORDER_PAID_BACKOFF } });
    expect(jobOptionsFor('order.cancelled', 15)).toEqual({ attempts: 15, backoff: { type: ORDER_PAID_BACKOFF } });
  });
});
