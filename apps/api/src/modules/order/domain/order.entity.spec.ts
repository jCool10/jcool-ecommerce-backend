import { describe, expect, it } from 'vitest';
import { DomainError } from '@jcool/kernel';
import { MAX_QUANTITY_PER_ORDER_LINE } from '../order.constants';
import { Order } from './order.entity';
import { OrderItem } from './order-item.entity';
import { OrderStatus } from './order-status';
import { OrderTransitionError } from './order-state-machine';
import { OrderPaidEvent } from './events/order-paid.event';
import { OrderFailedEvent } from './events/order-failed.event';
import { OrderExpiredEvent } from './events/order-expired.event';
import { OrderCancelledEvent } from './events/order-cancelled.event';

const line = (unitPriceMinor: number, quantity: number, skuId = 'sku-a', name = 'Widget'): OrderItem =>
  OrderItem.of(skuId, name, unitPriceMinor, quantity);

const orderIn = (status: OrderStatus): Order =>
  Order.rehydrate({
    id: 'order-1',
    userId: 'u',
    status,
    currency: 'VND',
    items: [line(100_000, 1)],
    totalAmountMinor: 100_000,
    placedAt: new Date('2026-01-01T00:00:00.000Z'),
  });

describe('Order entity', () => {
  const now = new Date('2026-02-02T00:00:00.000Z');

  it('create() builds a DRAFT order with no id or placedAt and a normalized currency', () => {
    const order = Order.create('user-1', 'vnd', [line(100_000, 2)]);

    expect(order.status).toBe(OrderStatus.DRAFT);
    expect(order.currency).toBe('VND');
    expect(order.id).toBeNull();
    expect(order.placedAt).toBeNull();
  });

  it('total() sums unit price times quantity over the snapshot lines', () => {
    const order = Order.create('u', 'VND', [line(199_000, 2, 'a'), line(50_000, 1, 'b')]);

    expect(order.total().amountMinor).toBe(448_000);
  });

  it('create() rejects an empty item list', () => {
    expect(() => Order.create('u', 'VND', [])).toThrow(DomainError);
  });

  it('create() accepts a line at the per-order-line cap and rejects one past it', () => {
    expect(Order.create('u', 'VND', [line(1_000, MAX_QUANTITY_PER_ORDER_LINE)]).items).toHaveLength(1);
    expect(() => Order.create('u', 'VND', [line(1_000, MAX_QUANTITY_PER_ORDER_LINE + 1)])).toThrow(DomainError);
  });

  it('rehydrate() keeps a line above the cap, so orders placed before it stay readable', () => {
    const order = Order.rehydrate({
      id: 'order-1',
      userId: 'u',
      status: OrderStatus.PENDING,
      currency: 'VND',
      items: [line(1_000, MAX_QUANTITY_PER_ORDER_LINE + 1)],
      totalAmountMinor: 1_000 * (MAX_QUANTITY_PER_ORDER_LINE + 1),
      placedAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    expect(order.items[0].quantity).toBe(MAX_QUANTITY_PER_ORDER_LINE + 1);
  });

  it('reserve() moves a draft to RESERVING and stamps placedAt, leaving the original untouched', () => {
    const draft = Order.create('u', 'VND', [line(100_000, 1)]);

    const reserving = draft.reserve(now);

    expect(reserving.status).toBe(OrderStatus.RESERVING);
    expect(reserving.placedAt).toBe(now);
    expect(reserving.isTerminal()).toBe(false);
    expect(draft.status).toBe(OrderStatus.DRAFT);
    expect(draft.placedAt).toBeNull();
  });

  it('confirmPlaced() moves a reserving order to PENDING and keeps placedAt', () => {
    const pending = orderIn(OrderStatus.RESERVING).confirmPlaced();

    expect(pending.status).toBe(OrderStatus.PENDING);
    expect(pending.placedAt).toEqual(new Date('2026-01-01T00:00:00.000Z'));
    expect(pending.finalizedAt).toBeNull();
  });

  it('reject() moves a reserving order to REJECTED and stamps finalizedAt and the reason', () => {
    const rejected = orderIn(OrderStatus.RESERVING).reject('try:out_of_stock', now);

    expect(rejected.status).toBe(OrderStatus.REJECTED);
    expect(rejected.isTerminal()).toBe(true);
    expect(rejected.finalizedAt).toBe(now);
    expect(rejected.finalizeReason).toBe('try:out_of_stock');
  });

  it('reject() refuses an order that already left RESERVING', () => {
    expect(() => orderIn(OrderStatus.PENDING).reject('try:timeout', now)).toThrow(OrderTransitionError);
  });

  it('confirming() moves a pending order to CONFIRMING without settling it', () => {
    const confirming = orderIn(OrderStatus.PENDING).confirming();

    expect(confirming.status).toBe(OrderStatus.CONFIRMING);
    expect(confirming.isTerminal()).toBe(false);
    expect(confirming.finalizedAt).toBeNull();
  });

  describe('settle()', () => {
    it('moves a confirming order to PAID and stamps the settlement, leaving the original untouched', () => {
      const confirming = orderIn(OrderStatus.CONFIRMING);

      const paid = confirming.settle(OrderStatus.PAID, { now, reason: 'payment:captured', paymentRef: 'pay_123' });

      expect(paid.status).toBe(OrderStatus.PAID);
      expect(paid.isTerminal()).toBe(true);
      expect(paid.finalizedAt).toBe(now);
      expect(paid.finalizeReason).toBe('payment:captured');
      expect(paid.paymentRef).toBe('pay_123');
      expect(confirming.status).toBe(OrderStatus.CONFIRMING);
      expect(confirming.finalizedAt).toBeNull();
    });

    it.each([
      [OrderStatus.CONFIRMING, OrderStatus.FAILED],
      [OrderStatus.PENDING, OrderStatus.FAILED],
      [OrderStatus.PENDING, OrderStatus.EXPIRED],
      [OrderStatus.PENDING, OrderStatus.CANCELLED],
    ] as const)('stamps finalizedAt when %s settles as %s', (from, outcome) => {
      const settled = orderIn(from).settle(outcome, { now, reason: 'why' });

      expect(settled.status).toBe(outcome);
      expect(settled.finalizedAt).toBe(now);
      expect(settled.finalizeReason).toBe('why');
    });

    it('throws OrderTransitionError on an edge the state machine does not wire', () => {
      expect(() => orderIn(OrderStatus.PENDING).settle(OrderStatus.PAID, { now })).toThrow(OrderTransitionError);
      expect(() => orderIn(OrderStatus.CONFIRMING).settle(OrderStatus.CANCELLED, { now })).toThrow(
        OrderTransitionError,
      );
      expect(() => orderIn(OrderStatus.PAID).settle(OrderStatus.FAILED, { now })).toThrow(OrderTransitionError);
    });
  });

  describe('toPlacedEvent()', () => {
    it('describes a PENDING order', () => {
      expect(orderIn(OrderStatus.PENDING).toPlacedEvent()).toMatchObject({
        orderId: 'order-1',
        totalAmountMinor: 100_000,
        currency: 'VND',
      });
    });

    it('throws for an order still reserving stock', () => {
      expect(() => orderIn(OrderStatus.RESERVING).toPlacedEvent()).toThrow(DomainError);
    });
  });

  describe('toFinalizedEvent()', () => {
    it('produces the event matching the terminal outcome', () => {
      const paid = orderIn(OrderStatus.CONFIRMING)
        .settle(OrderStatus.PAID, { now, paymentRef: 'pay_1' })
        .toFinalizedEvent();
      expect(paid).toBeInstanceOf(OrderPaidEvent);
      expect(paid).toMatchObject({
        eventName: 'order.paid',
        aggregateId: 'order-1',
        paymentRef: 'pay_1',
        occurredAt: now,
      });

      const failed = orderIn(OrderStatus.CONFIRMING).settle(OrderStatus.FAILED, { now }).toFinalizedEvent();
      expect(failed).toBeInstanceOf(OrderFailedEvent);
      expect(failed).toMatchObject({ reason: null });
      expect(orderIn(OrderStatus.PENDING).settle(OrderStatus.EXPIRED, { now }).toFinalizedEvent()).toBeInstanceOf(
        OrderExpiredEvent,
      );

      const cancelled = orderIn(OrderStatus.PENDING).settle(OrderStatus.CANCELLED, { now, reason: 'user:cancel' });
      expect(cancelled.toFinalizedEvent()).toBeInstanceOf(OrderCancelledEvent);
      expect(cancelled.toFinalizedEvent()).toMatchObject({
        eventName: 'order.cancelled',
        aggregateId: 'order-1',
        reason: 'user:cancel',
        occurredAt: now,
      });
    });

    it('throws for an order that has not settled, and for a rejected one, which nobody was ever shown', () => {
      expect(() => orderIn(OrderStatus.PENDING).toFinalizedEvent()).toThrow(DomainError);
      expect(() => orderIn(OrderStatus.RESERVING).reject('try:contended', now).toFinalizedEvent()).toThrow(DomainError);
    });
  });
});
