import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '@shared/infrastructure/database';
import { Order } from '../domain/order.entity';
import { OrderItem } from '../domain/order-item.entity';
import { OrderStatus } from '../domain/order-status';
import type { OrderRepositoryPort } from '../application/ports/order-repository.port';
import { orderItems, orders } from './schema/order.schema';

type OrderRow = typeof orders.$inferSelect;
type OrderItemRow = typeof orderItems.$inferSelect;

/**
 * Drizzle adapter for OrderRepositoryPort. Writes (create, markPlaced) run inside
 * a transaction so later weeks can add reserve (BF#1) / outbox (BF#4) in the SAME
 * transaction without reshaping this layer. `markPlaced` is a conditional UPDATE
 * (WHERE status = expected) — atomic optimistic concurrency, no read-modify-write.
 */
@Injectable()
export class DrizzleOrderRepository implements OrderRepositoryPort {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  async create(order: Order): Promise<string> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(orders)
        .values({
          userId: order.userId,
          status: order.status,
          currency: order.currency,
          totalAmount: order.totalAmountMinor,
        })
        .returning({ id: orders.id });
      const orderId = row.id;

      await tx.insert(orderItems).values(
        order.items.map((item) => ({
          orderId,
          skuId: item.skuId,
          productName: item.productName,
          unitPrice: item.unitPriceMinor,
          quantity: item.quantity,
        })),
      );
      return orderId;
    });
  }

  async findForUser(orderId: string, userId: string): Promise<Order | null> {
    // User-scoped by design: another user's order id simply returns null (→ 404).
    const [row] = await this.db
      .select()
      .from(orders)
      .where(and(eq(orders.id, orderId), eq(orders.userId, userId)))
      .limit(1);
    if (!row) {
      return null;
    }
    const itemRows = await this.db
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, orderId))
      .orderBy(orderItems.createdAt, orderItems.id);
    return toDomainOrder(row, itemRows);
  }

  async findAllForUser(userId: string): Promise<Order[]> {
    const orderRows = await this.db
      .select()
      .from(orders)
      .where(eq(orders.userId, userId))
      .orderBy(desc(orders.createdAt), desc(orders.id));
    if (orderRows.length === 0) {
      return [];
    }

    const ids = orderRows.map((row) => row.id);
    const itemRows = await this.db
      .select()
      .from(orderItems)
      .where(inArray(orderItems.orderId, ids))
      .orderBy(orderItems.createdAt, orderItems.id);

    const itemsByOrder = new Map<string, OrderItemRow[]>();
    for (const item of itemRows) {
      const bucket = itemsByOrder.get(item.orderId) ?? [];
      bucket.push(item);
      itemsByOrder.set(item.orderId, bucket);
    }

    return orderRows.map((row) => toDomainOrder(row, itemsByOrder.get(row.id) ?? []));
  }

  async markPlaced(orderId: string, userId: string, expectedStatus: OrderStatus, placedAt: Date): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      // Conditional update: only flips a row still in the expected status, so a
      // concurrent place loses the race (returns no row) instead of double-placing.
      const updated = await tx
        .update(orders)
        .set({ status: OrderStatus.PENDING, placedAt })
        .where(and(eq(orders.id, orderId), eq(orders.userId, userId), eq(orders.status, expectedStatus)))
        .returning({ id: orders.id });
      // EXTENSION BF#1 (T4): reserve stock here, in this transaction, before returning.
      // EXTENSION BF#4 (T8-9): append OrderPlaced to the outbox here, in this transaction.
      return updated.length > 0;
    });
  }
}

// Row → domain aggregate. Items are already the frozen snapshot, so rehydration
// never touches Catalog.
function toDomainOrder(row: OrderRow, itemRows: OrderItemRow[]): Order {
  return Order.rehydrate({
    id: row.id,
    userId: row.userId,
    status: row.status,
    currency: row.currency,
    totalAmountMinor: row.totalAmount,
    placedAt: row.placedAt,
    items: itemRows.map((item) => OrderItem.of(item.skuId, item.productName, item.unitPrice, item.quantity)),
  });
}
