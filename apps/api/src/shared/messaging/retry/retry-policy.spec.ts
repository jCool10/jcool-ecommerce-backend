import { afterEach, describe, expect, it, vi } from 'vitest';
import configuration from '@shared/config/configuration';
import {
  EXPIRY_CLOCK_MARGIN_SEC,
  SESSION_LIFETIME_SEC,
} from '@modules/payment/infrastructure/gateway/stripe-gateway.adapter';
import { dispatcherWith } from '../testing/domain-event-dispatcher.double';
import {
  MAX_REDELIVERY_AGE_SEC,
  MIN_INBOX_RETENTION_DAYS,
  cappedBackoffMs,
  retryHorizonMs,
  retryPolicyFor,
  type RetryLadderConfig,
} from './retry-policy';

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

describe('retryPolicyFor', () => {
  const ladder: RetryLadderConfig = {
    consumerAttempts: 8,
    consumerBackoffMs: 1_000,
    orderPaidAttempts: 15,
    orderPaidBackoffCapMs: 300_000,
  };
  const SHORT = 'short';
  const LONG = 'long';

  // Every event the dispatcher registers, so a new handler cannot silently land on the wrong ladder.
  const registered = [
    ['order.placed', SHORT],
    ['order.failed', SHORT],
    ['payment.succeeded', SHORT],
    ['payment.failed', SHORT],
    ['order.paid', LONG],
    ['order.expired', LONG],
    ['order.cancelled', LONG],
    ['catalog.product.changed', LONG],
    ['catalog.category.renamed', LONG],
  ] as const;

  it.each(registered)('puts %s on the %s ladder', (eventType, rung) => {
    const policy = retryPolicyFor(eventType, ladder);
    const delays = [1, 2, 3, 10, 14].map((n) => policy.delayAfter(n));

    expect(dispatcherWith().label(eventType)).toBe(eventType);
    if (rung === LONG) {
      expect(policy.attempts).toBe(ladder.orderPaidAttempts);
      expect(delays).toEqual([1, 2, 3, 10, 14].map((n) => cappedBackoffMs(n, 1_000, 300_000)));
    } else {
      expect(policy.attempts).toBe(ladder.consumerAttempts);
      expect(delays).toEqual([1_000, 2_000, 4_000, 512_000, 8_192_000]);
    }
  });

  it('retries an event nothing handles on the short ladder', () => {
    expect(retryPolicyFor('payment.refunded', ladder).attempts).toBe(ladder.consumerAttempts);
  });

  it('derives the inbox floor from the redelivery horizon in whole days', () => {
    expect(MIN_INBOX_RETENTION_DAYS * 86_400).toBeGreaterThanOrEqual(MAX_REDELIVERY_AGE_SEC);
    expect((MIN_INBOX_RETENTION_DAYS - 1) * 86_400).toBeLessThan(MAX_REDELIVERY_AGE_SEC);
  });
});
