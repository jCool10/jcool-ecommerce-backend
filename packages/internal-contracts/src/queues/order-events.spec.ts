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

  // Both wait on another service: the buyer's address for order.paid, Temporal for payment.authorized.
  it.each(['order.paid', PAYMENT_AUTHORIZED_EVENT])('puts %s on the long ladder the producer sizes', (eventType) => {
    expect(orderEventsJobOptions(eventType, 12)).toEqual({ attempts: 12, backoff: { type: ORDER_PAID_BACKOFF } });
  });

  it.each(['order.placed', 'order.failed', 'order.expired', 'order.cancelled'])(
    'leaves %s on the queue defaults',
    (eventType) => {
      expect(orderEventsJobOptions(eventType, 12)).toEqual({});
    },
  );

  it('gives no event a priority', () => {
    expect(orderEventsJobOptions('order.paid', 12)).not.toHaveProperty('priority');
  });
});
