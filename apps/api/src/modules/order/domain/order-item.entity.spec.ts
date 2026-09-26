import { describe, expect, it } from 'vitest';
import { MAX_QUANTITY_PER_ORDER_LINE } from '../order.constants';
import { OrderItem } from './order-item.entity';

describe('OrderItem', () => {
  it('still rehydrates a line above the per-order-line cap, placed before the cap existed', () => {
    const item = OrderItem.of('sku-1', 'Widget', 1_000, MAX_QUANTITY_PER_ORDER_LINE + 1);

    expect(item.quantity).toBe(MAX_QUANTITY_PER_ORDER_LINE + 1);
  });
});
