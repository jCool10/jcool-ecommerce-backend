import { describe, expect, it } from 'vitest';
import { Order } from './order.entity';
import { OrderItem } from './order-item.entity';
import { OrderStatus } from './order-status';
import { OrderTransitionError } from './order-state-machine';

const line = (unitPriceMinor: number, quantity: number, skuId = 'sku-a', name = 'Widget'): OrderItem =>
  OrderItem.of(skuId, name, unitPriceMinor, quantity);

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
    const pending = Order.rehydrate({
      id: 'order-1',
      userId: 'u',
      status: OrderStatus.PENDING,
      currency: 'VND',
      items: [line(100_000, 1)],
      totalAmountMinor: 100_000,
      placedAt: new Date(),
    });

    expect(() => pending.place(new Date())).toThrow(OrderTransitionError);
  });
});
