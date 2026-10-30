import { afterEach, describe, expect, it, vi } from 'vitest';
import { cappedBackoffMs, destinationsOf, retryHorizonMs, routeOf } from '@jcool/messaging';
import configuration from '../../config/configuration';
import type { OrderFinalizedEvent } from '../../modules/order/domain/order.entity';
import { ORDER_CONSUMED_QUEUES, ORDER_EVENT_ROUTES } from './order-events.routes';

const MINUTE_MS = 60_000;
const LADDER_ENV = [
  'QUEUE_CONSUMER_ATTEMPTS',
  'QUEUE_CONSUMER_BACKOFF_MS',
  'ORDER_PAID_CONSUMER_ATTEMPTS',
  'ORDER_PAID_CONSUMER_BACKOFF_CAP_MS',
];

// From the domain type, so a new finalized event fails typecheck here until it is routed.
const ORDER_EVENT_TYPES = Object.keys({
  'order.placed': true,
  'order.paid': true,
  'order.failed': true,
  'order.expired': true,
  'order.cancelled': true,
} satisfies Record<OrderFinalizedEvent['eventName'] | 'order.placed', true>);

describe('order-service event routes', () => {
  it('sends every order event to order-events, and nothing else', () => {
    expect(Object.keys(ORDER_EVENT_ROUTES).sort()).toEqual([...ORDER_EVENT_TYPES].sort());
    expect(ORDER_EVENT_TYPES.map((eventType) => routeOf(ORDER_EVENT_ROUTES, eventType)?.name)).toEqual(
      Array(ORDER_EVENT_TYPES.length).fill('order-events'),
    );
  });

  it('gives no event a priority', () => {
    for (const [eventType, route] of Object.entries(ORDER_EVENT_ROUTES)) {
      expect(route.jobOptionsFor(eventType, 15), eventType).not.toHaveProperty('priority');
    }
  });

  it('consumes order-events alone, under its consumer group and dead-letter queue', () => {
    expect(destinationsOf(ORDER_EVENT_ROUTES).map(({ name }) => name)).toEqual(['order-events']);
    expect(ORDER_CONSUMED_QUEUES.map(({ name, consumer, dlq }) => [name, consumer, dlq])).toEqual([
      ['order-events', 'order-events', 'order-events-dlq'],
    ]);
  });
});

describe('retry ladders', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // order.paid must ride out a user-service outage.
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
