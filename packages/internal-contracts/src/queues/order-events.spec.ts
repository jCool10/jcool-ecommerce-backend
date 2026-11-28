import { CATALOG_SKU_SNAPSHOT_EVENT } from '../events/catalog-sku-snapshot';
import { PAYMENT_AUTHORIZED_EVENT } from '../events/payment-authorized';
import {
  ORDER_EVENTS_CONSUMER,
  ORDER_EVENTS_DLQ,
  ORDER_EVENTS_QUEUE,
  ORDER_PAID_BACKOFF,
  orderEventsJobOptions,
} from './order-events';

describe('order-events queue', () => {
  it('names the queue, its dead letters and the consumer group apart from any other queue', () => {
    expect(ORDER_EVENTS_QUEUE).toBe('order-events');
    expect(ORDER_EVENTS_DLQ).toBe('order-events-dlq');
    expect(ORDER_EVENTS_CONSUMER).toBe('order-events');
  });

  // Each waits on something that may be down for minutes: the buyer's address for the two mails,
  // Temporal for payment.authorized, the order-service's database for a catalog snapshot.
  it.each(['order.paid', 'order.refunded', PAYMENT_AUTHORIZED_EVENT, CATALOG_SKU_SNAPSHOT_EVENT])(
    'puts %s on the long ladder the producer sizes',
    (eventType) => {
      expect(orderEventsJobOptions(eventType, 12)).toEqual({ attempts: 12, backoff: { type: ORDER_PAID_BACKOFF } });
    },
  );

  it.each(['order.placed', 'order.failed', 'order.expired', 'order.cancelled'])(
    'leaves %s on the queue defaults',
    (eventType) => {
      expect(orderEventsJobOptions(eventType, 12)).toEqual({});
    },
  );
});
