import { describe, expect, it } from 'vitest';
import { OrderPlacedEvent } from '../domain/events/order-placed.event';
import { OrderPaidEvent } from '../domain/events/order-paid.event';
import { OrderFailedEvent } from '../domain/events/order-failed.event';
import { OrderExpiredEvent } from '../domain/events/order-expired.event';
import { toFinalizedOutboxRecord, toPlacedOutboxRecord } from './order-outbox.mapper';

const ORDER_ID = '01a03000-0000-7000-8000-000000000001';
const USER_ID = '01a03000-0000-7000-8000-000000000002';
const AT = new Date('2026-08-24T03:21:00.000Z');
const ISO = '2026-08-24T03:21:00.000Z';

// The payload is what a consumer sees days after the fact, so its shape is a contract: pin every
// key, and pin that timestamps serialize as ISO strings rather than Date objects jsonb would mangle.
describe('order outbox mapper', () => {
  it('maps a placed order to an order.placed record', () => {
    const record = toPlacedOutboxRecord(new OrderPlacedEvent(ORDER_ID, USER_ID, 300_000, 'VND', AT));

    expect(record).toEqual({
      aggregateType: 'Order',
      aggregateId: ORDER_ID,
      eventType: 'order.placed',
      payload: { orderId: ORDER_ID, userId: USER_ID, totalAmountMinor: 300_000, currency: 'VND', placedAt: ISO },
    });
  });

  it('maps a paid outcome to an order.paid record carrying the money and the gateway handle', () => {
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

  it('maps a failed outcome to an order.failed record carrying the reason, not the money', () => {
    const record = toFinalizedOutboxRecord(new OrderFailedEvent(ORDER_ID, USER_ID, 'webhook:failed', AT));

    expect(record).toEqual({
      aggregateType: 'Order',
      aggregateId: ORDER_ID,
      eventType: 'order.failed',
      payload: { orderId: ORDER_ID, userId: USER_ID, occurredAt: ISO, reason: 'webhook:failed' },
    });
  });

  it('maps an expired outcome to an order.expired record, distinct from failed', () => {
    const record = toFinalizedOutboxRecord(new OrderExpiredEvent(ORDER_ID, USER_ID, null, AT));

    expect(record).toEqual({
      aggregateType: 'Order',
      aggregateId: ORDER_ID,
      eventType: 'order.expired',
      payload: { orderId: ORDER_ID, userId: USER_ID, occurredAt: ISO, reason: null },
    });
  });
});
