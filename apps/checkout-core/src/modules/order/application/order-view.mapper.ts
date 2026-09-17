import { NotFoundException } from '@nestjs/common';
import type { Order } from '../domain/order.entity';
import type { OrderStatus } from '../domain/order-status';
import type { OrderRepositoryPort } from './ports/order-repository.port';

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

// Totals come from the snapshot lines, so they are stable against later Catalog price changes.
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

// Write use-cases call this after a mutation so the client always sees persisted state.
export async function loadOrderView(repo: OrderRepositoryPort, orderId: string, userId: string): Promise<OrderView> {
  const order = await repo.findForUser(orderId, userId);
  if (!order) {
    throw new NotFoundException(`Order not found: ${orderId}`);
  }
  return toView(order);
}
