import { describe, expect, it } from 'vitest';
import { OrderPaidEvent } from '../domain/events/order-paid.event';
import { OrderFailedEvent } from '../domain/events/order-failed.event';
import { OrderExpiredEvent } from '../domain/events/order-expired.event';
import { OrderCancelledEvent } from '../domain/events/order-cancelled.event';
import { toFinalizedOutboxRecord } from './order-outbox.mapper';

const ORDER_ID = '01a03000-0000-7000-8000-000000000001';
const USER_ID = '01a03000-0000-7000-8000-000000000002';
const AT = new Date('2026-08-24T03:21:00.000Z');
const ISO = '2026-08-24T03:21:00.000Z';

describe('order outbox mapper', () => {
  it('maps a paid outcome to order.paid with the money and the gateway handle', () => {
    const record = toFinalizedOutboxRecord(new OrderPaidEvent(ORDER_ID, USER_ID, 300_000, 'VND', 'pi_123', AT));

    expect(record).toEqual({
      aggregateType: 'Order',
      aggregateId: ORDER_ID,
      eventType: 'order.paid',
      payload: {
        orderId: ORDER_ID,
        userId: USER_ID,
        occurredAt: ISO,
        totalAmountMinor: 300_000,
        currency: 'VND',
        paymentRef: 'pi_123',
      },
    });
  });

  it('keeps paymentRef explicit when a paid outcome carried no gateway handle', () => {
    // The sweep can confirm PAID without echoing a ref; the key must still be present so a consumer
    // reads an explicit null instead of an absent field it might mistake for an older payload shape.
    const record = toFinalizedOutboxRecord(new OrderPaidEvent(ORDER_ID, USER_ID, 300_000, 'VND', null, AT));

    expect(record.payload).toMatchObject({ paymentRef: null });
  });

  it('maps the other outcomes to their own events carrying the reason, not money', () => {
    const events = [
      new OrderFailedEvent(ORDER_ID, USER_ID, 'webhook:failed', AT),
      new OrderExpiredEvent(ORDER_ID, USER_ID, null, AT),
      new OrderCancelledEvent(ORDER_ID, USER_ID, 'user:cancelled', AT),
    ];

    expect(events.map(toFinalizedOutboxRecord)).toEqual([
      {
        aggregateType: 'Order',
        aggregateId: ORDER_ID,
        eventType: 'order.failed',
        payload: { orderId: ORDER_ID, userId: USER_ID, occurredAt: ISO, reason: 'webhook:failed' },
      },
      {
        aggregateType: 'Order',
        aggregateId: ORDER_ID,
        eventType: 'order.expired',
        payload: { orderId: ORDER_ID, userId: USER_ID, occurredAt: ISO, reason: null },
      },
      {
        aggregateType: 'Order',
        aggregateId: ORDER_ID,
        eventType: 'order.cancelled',
        payload: { orderId: ORDER_ID, userId: USER_ID, occurredAt: ISO, reason: 'user:cancelled' },
      },
    ]);
  });
});
