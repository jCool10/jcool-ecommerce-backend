import type { CheckoutSagaMode } from '../domain/checkout-saga';
import type { Order } from '../domain/order.entity';
import type { CheckoutSagaStart } from './ports/checkout-saga-engine.port';

/** Every saga input comes from the saved order, so a retry or a late start rebuilds the same run. */
export function toCheckoutSagaStart(order: Order, mode: CheckoutSagaMode): CheckoutSagaStart {
  if (!order.id || !order.placedAt || !order.paymentDeadlineAt) {
    throw new Error(`Order ${order.id ?? '(unsaved)'} was not placed through the checkout saga`);
  }
  return {
    mode,
    orderId: order.id,
    userId: order.userId,
    lines: order.items.map(({ skuId, quantity }) => ({ skuId, quantity })),
    totalMinor: order.totalAmountMinor,
    currency: order.currency,
    placedAt: order.placedAt,
    deadlineAt: order.paymentDeadlineAt,
  };
}
