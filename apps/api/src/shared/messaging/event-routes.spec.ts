import { afterEach, describe, expect, it, vi } from 'vitest';
import { PAYMENT_AUTHORIZED_EVENT } from '@jcool/internal-contracts/events/payment-authorized';
import { ORDER_PAID_BACKOFF } from '@jcool/internal-contracts/queues/order-events';
import { cappedBackoffMs, destinationsOf, retryHorizonMs, routeOf } from '@jcool/messaging';
import {
  CATEGORY_RENAMED_EVENT,
  PRODUCT_CHANGED_EVENT,
} from '@modules/product/application/catalog/catalog-outbox.mapper';
import configuration from '@shared/config/configuration';
import { API_CONSUMED_QUEUES, API_EVENT_ROUTES } from './event-routes';

const MINUTE_MS = 60_000;
const LADDER_ENV = [
  'QUEUE_CONSUMER_ATTEMPTS',
  'QUEUE_CONSUMER_BACKOFF_MS',
  'ORDER_PAID_CONSUMER_ATTEMPTS',
  'ORDER_PAID_CONSUMER_BACKOFF_CAP_MS',
];

const CATALOG_EVENT_TYPES = [PRODUCT_CHANGED_EVENT, CATEGORY_RENAMED_EVENT];

const queueOf = (eventType: string) => routeOf(API_EVENT_ROUTES, eventType)?.name;

describe('api event routes', () => {
  it('sends catalog events to api-events, on the long ladder', () => {
    for (const eventType of CATALOG_EVENT_TYPES) {
      expect(queueOf(eventType), eventType).toBe('api-events');
      expect(routeOf(API_EVENT_ROUTES, eventType)?.jobOptionsFor(eventType, 15)).toEqual({
        attempts: 15,
        backoff: { type: ORDER_PAID_BACKOFF },
      });
    }
  });

  it('routes no order or payment event, which other services publish now', () => {
    const foreign = ['order.placed', 'order.paid', 'order.failed', 'order.expired', 'order.cancelled'];

    for (const eventType of [...foreign, PAYMENT_AUTHORIZED_EVENT]) {
      expect(queueOf(eventType), eventType).toBeUndefined();
    }
  });

  // One queue per consumer is what made the priority unnecessary.
  it('gives no event a priority', () => {
    for (const [eventType, route] of Object.entries(API_EVENT_ROUTES)) {
      expect(route.jobOptionsFor(eventType, 15), eventType).not.toHaveProperty('priority');
    }
  });

  it('consumes every queue it routes to, each under its own consumer group and dead-letter queue', () => {
    expect(destinationsOf(API_EVENT_ROUTES).map(({ name }) => name)).toEqual(
      API_CONSUMED_QUEUES.map(({ name }) => name),
    );
    expect(API_CONSUMED_QUEUES.map(({ consumer, dlq }) => [consumer, dlq])).toEqual([['api-events', 'api-events-dlq']]);
  });
});

describe('retry ladders', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // The README quotes both horizons; catalog events ride the order.paid ladder through a search outage.
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
