import { NotFoundException } from '@nestjs/common';
import type { Order } from '../domain/order.entity';
import type { OrderStatus } from '../domain/order-status';
import type { OrderRepositoryPort } from './ports/order-repository.port';

/** One order line as returned to the client (from the snapshot, not a live price). */
export interface OrderItemView {
  skuId: string;
  productName: string;
  unitPriceMinor: number;
  quantity: number;
  lineTotalMinor: number;
}

export interface OrderView {
  id: string;
  status: OrderStatus;
  currency: string;
  totalAmountMinor: number;
  placedAt: string | null;
  items: OrderItemView[];
}

// Map the domain aggregate to the read model. Totals come from the snapshot lines,
// so they are stable against later Catalog price changes.
export function toView(order: Order): OrderView {
  return {
    id: order.id as string,
    status: order.status,
    currency: order.currency,
    totalAmountMinor: order.total().amountMinor,
    placedAt: order.placedAt ? order.placedAt.toISOString() : null,
    items: order.items.map((item) => ({
      skuId: item.skuId,
      productName: item.productName,
      unitPriceMinor: item.unitPriceMinor,
      quantity: item.quantity,
      lineTotalMinor: item.lineTotal(order.currency).amountMinor,
    })),
  };
}

// Re-read after a mutation (or for a point read) so the client always sees
// persisted state. Shared by the write use-cases and the query service.
export async function loadOrderView(repo: OrderRepositoryPort, orderId: string, userId: string): Promise<OrderView> {
  const order = await repo.findForUser(orderId, userId);
  if (!order) {
    throw new NotFoundException(`Order not found: ${orderId}`);
  }
  return toView(order);
}
