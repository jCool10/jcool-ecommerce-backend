import { describe, expect, it } from 'vitest';
import { Order } from './order.entity';
import { OrderItem } from './order-item.entity';
import { OrderStatus } from './order-status';
import { OrderTransitionError } from './order-state-machine';
import { OrderPaidEvent } from './events/order-paid.event';
import { OrderFailedEvent } from './events/order-failed.event';
import { OrderExpiredEvent } from './events/order-expired.event';

const line = (unitPriceMinor: number, quantity: number, skuId = 'sku-a', name = 'Widget'): OrderItem =>
  OrderItem.of(skuId, name, unitPriceMinor, quantity);

const pendingOrder = (status: OrderStatus = OrderStatus.PENDING): Order =>
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
  it('create() builds a DRAFT order (no id/placedAt yet) with a normalized currency', () => {
    const order = Order.create('user-1', 'vnd', [line(100_000, 2)]);

    expect(order.status).toBe(OrderStatus.DRAFT);
    expect(order.currency).toBe('VND'); // Money normalizes the code
    expect(order.id).toBeNull();
    expect(order.placedAt).toBeNull();
  });

  it('total() sums unit × quantity over the snapshot lines', () => {
    const order = Order.create('u', 'VND', [line(199_000, 2, 'a'), line(50_000, 1, 'b')]);

    expect(order.total().amountMinor).toBe(448_000);
  });

  it('create() rejects an empty item list', () => {
    expect(() => Order.create('u', 'VND', [])).toThrow();
  });

  it('place() moves DRAFT → PENDING and stamps placedAt, leaving the original untouched (immutable)', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const draft = Order.create('u', 'VND', [line(100_000, 1)]);

    const placed = draft.place(now);

    expect(placed.status).toBe(OrderStatus.PENDING);
    expect(placed.placedAt).toBe(now);
    expect(draft.status).toBe(OrderStatus.DRAFT); // original unchanged
    expect(draft.placedAt).toBeNull();
  });

  it('place() throws OrderTransitionError from a non-DRAFT state', () => {
    expect(() => pendingOrder().place(new Date())).toThrow(OrderTransitionError);
  });

  describe('finalize()', () => {
    const now = new Date('2026-02-02T00:00:00.000Z');

    it('moves PENDING → PAID and stamps finalizedAt/reason/paymentRef, leaving the original untouched', () => {
      const pending = pendingOrder();

      const paid = pending.finalize(OrderStatus.PAID, { now, reason: 'webhook:paid', paymentRef: 'pay_123' });

      expect(paid.status).toBe(OrderStatus.PAID);
      expect(paid.finalizedAt).toBe(now);
      expect(paid.finalizeReason).toBe('webhook:paid');
      expect(paid.paymentRef).toBe('pay_123');
      expect(pending.status).toBe(OrderStatus.PENDING); // immutable — original unchanged
      expect(pending.finalizedAt).toBeNull();
    });

    it('moves PENDING → FAILED and PENDING → EXPIRED', () => {
      expect(pendingOrder().finalize(OrderStatus.FAILED, { now }).status).toBe(OrderStatus.FAILED);
      expect(pendingOrder().finalize(OrderStatus.EXPIRED, { now }).status).toBe(OrderStatus.EXPIRED);
    });

    it('defaults reason/paymentRef to null when omitted', () => {
      const failed = pendingOrder().finalize(OrderStatus.FAILED, { now });

      expect(failed.finalizeReason).toBeNull();
      expect(failed.paymentRef).toBeNull();
    });

    it('throws OrderTransitionError when finalizing a non-PENDING order', () => {
      expect(() => pendingOrder(OrderStatus.DRAFT).finalize(OrderStatus.PAID, { now })).toThrow(OrderTransitionError);
      expect(() => pendingOrder(OrderStatus.PAID).finalize(OrderStatus.FAILED, { now })).toThrow(OrderTransitionError);
    });
  });

  describe('isTerminal()', () => {
    it('is true for settled orders, false for DRAFT/PENDING', () => {
      expect(pendingOrder(OrderStatus.PAID).isTerminal()).toBe(true);
      expect(pendingOrder(OrderStatus.FAILED).isTerminal()).toBe(true);
      expect(pendingOrder(OrderStatus.EXPIRED).isTerminal()).toBe(true);
      expect(pendingOrder(OrderStatus.PENDING).isTerminal()).toBe(false);
      expect(pendingOrder(OrderStatus.DRAFT).isTerminal()).toBe(false);
    });
  });

  describe('toFinalizedEvent()', () => {
    const now = new Date('2026-02-02T00:00:00.000Z');

    it('produces the event matching the terminal outcome', () => {
      const paid = pendingOrder().finalize(OrderStatus.PAID, { now, paymentRef: 'pay_1' }).toFinalizedEvent();
      expect(paid).toBeInstanceOf(OrderPaidEvent);
      expect(paid).toMatchObject({
        eventName: 'order.paid',
        aggregateId: 'order-1',
        paymentRef: 'pay_1',
        occurredAt: now,
      });

      expect(pendingOrder().finalize(OrderStatus.FAILED, { now }).toFinalizedEvent()).toBeInstanceOf(OrderFailedEvent);
      expect(pendingOrder().finalize(OrderStatus.EXPIRED, { now }).toFinalizedEvent()).toBeInstanceOf(
        OrderExpiredEvent,
      );
    });

    it('throws for an order that has not been finalized', () => {
      expect(() => pendingOrder().toFinalizedEvent()).toThrow();
    });
  });
});
