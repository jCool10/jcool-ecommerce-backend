import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, desc, eq, inArray, lt, type SQL } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB, type DrizzleTx } from '@shared/infrastructure/database';
import { Order } from '../domain/order.entity';
import { OrderStatus } from '../domain/order-status';
import { OrderItem } from '../domain/order-item.entity';
import type {
  AdminOrderPageQuery,
  CheckoutPersistResult,
  OrderPage,
  OrderPageQuery,
  OrderRepositoryPort,
  StalePendingOrder,
} from '../application/ports/order-repository.port';
import { orderItems, orders } from './schema/order.schema';

type OrderRow = typeof orders.$inferSelect;
type OrderItemRow = typeof orderItems.$inferSelect;

@Injectable()
export class DrizzleOrderRepository implements OrderRepositoryPort {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  async createCheckout(
    order: Order,
    buyerEmail: string,
    idempotencyKey: string | null,
    reserve: (tx: DrizzleTx, orderId: string) => Promise<void>,
    appendEvent: (tx: DrizzleTx, orderId: string) => Promise<void>,
    complete: (tx: DrizzleTx, orderId: string) => Promise<void>,
  ): Promise<CheckoutPersistResult> {
    return this.db.transaction(async (tx) => {
      if (idempotencyKey) {
        // Exit-defense: a prior attempt already committed an order under this key (its idempotency
        // row was then reclaimed). Serialized by the idempotency-key entry gate — at most one
        // checkout runs per key at a time — so this read-then-insert cannot lose a race; the unique
        // `orders.idempotency_key` is the final backstop if that ever fails to hold.
        const [existing] = await tx
          .select({ id: orders.id })
          .from(orders)
          .where(and(eq(orders.idempotencyKey, idempotencyKey), eq(orders.userId, order.userId)))
          .limit(1);
        if (existing) {
          return { orderId: existing.id, created: false };
        }
      }

      const [row] = await tx
        .insert(orders)
        .values({
          userId: order.userId,
          buyerEmail,
          status: order.status,
          currency: order.currency,
          totalAmount: order.totalAmountMinor,
          idempotencyKey,
          placedAt: order.placedAt,
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

      // Same tx as the insert above, so there can be no placed order without its event and no event
      // for an order that never committed. `complete` is last: any earlier failure aborts before the
      // idempotency key is marked COMPLETED.
      await reserve(tx, orderId);
      await appendEvent(tx, orderId);
      await complete(tx, orderId);
      return { orderId, created: true };
    });
  }

  async withTransaction<T>(fn: (tx: DrizzleTx) => Promise<T>, join?: DrizzleTx): Promise<T> {
    // Reused as-is rather than nested: a nested drizzle transaction is a SAVEPOINT, which would let
    // this unit roll back on its own and leave the caller's — the inbox claim, say — committed.
    return join ? fn(join) : this.db.transaction(fn);
  }

  async findByIdForUpdate(orderId: string, tx: DrizzleTx): Promise<Order | null> {
    // The order row only: items are immutable snapshots, so they need no lock.
    const [row] = await tx.select().from(orders).where(eq(orders.id, orderId)).for('update').limit(1);
    if (!row) {
      return null;
    }
    const itemRows = await tx
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, orderId))
      .orderBy(orderItems.createdAt, orderItems.id);
    return toDomainOrder(row, itemRows);
  }

  async persistFinalization(order: Order, tx: DrizzleTx): Promise<void> {
    if (order.id === null) {
      throw new Error('Cannot persist finalization for an unsaved order');
    }
    await tx
      .update(orders)
      .set({
        status: order.status,
        finalizedAt: order.finalizedAt,
        finalizeReason: order.finalizeReason,
        paymentRef: order.paymentRef,
      })
      .where(eq(orders.id, order.id));
  }

  async findForUser(orderId: string, userId: string): Promise<Order | null> {
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

  async findById(orderId: string): Promise<Order | null> {
    const [row] = await this.db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
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

  findPageForUser(userId: string, query: OrderPageQuery): Promise<OrderPage> {
    return this.readPage(eq(orders.userId, userId), query);
  }

  findPage({ status, userId, ...query }: AdminOrderPageQuery): Promise<OrderPage> {
    const filters: SQL[] = [];
    if (status !== undefined) {
      filters.push(eq(orders.status, status));
    }
    if (userId !== undefined) {
      filters.push(eq(orders.userId, userId));
    }
    return this.readPage(filters.length > 0 ? and(...filters) : undefined, query);
  }

  // Page and total read in one repeatable-read snapshot, so a checkout committing between them
  // cannot produce a total that disagrees with the page the client is looking at.
  private readPage(where: SQL | undefined, { page, pageSize }: OrderPageQuery): Promise<OrderPage> {
    return this.db.transaction(
      async (tx) => {
        const [counted] = await tx.select({ value: count() }).from(orders).where(where);
        const total = counted?.value ?? 0;

        const orderRows = await tx
          .select()
          .from(orders)
          .where(where)
          // The id breaks ties: two orders placed in the same millisecond would otherwise be free to
          // swap places between pages, showing one twice and the other never.
          .orderBy(desc(orders.createdAt), desc(orders.id))
          .limit(pageSize)
          .offset((page - 1) * pageSize);
        if (orderRows.length === 0) {
          return { items: [], total };
        }

        const ids = orderRows.map((row) => row.id);
        const itemRows = await tx
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

        return { items: orderRows.map((row) => toDomainOrder(row, itemsByOrder.get(row.id) ?? [])), total };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }

  async findStalePending({ placedBefore, limit }: { placedBefore: Date; limit: number }): Promise<StalePendingOrder[]> {
    // `placed_at < :t` also drops NULLs, so the cast below is safe.
    const rows = await this.db
      .select({ id: orders.id, placedAt: orders.placedAt })
      .from(orders)
      .where(and(eq(orders.status, OrderStatus.PENDING), lt(orders.placedAt, placedBefore)))
      .orderBy(asc(orders.placedAt))
      .limit(limit)
      .for('update', { skipLocked: true });
    return rows.map((row) => ({ id: row.id, placedAt: row.placedAt as Date }));
  }
}

// Items are already the frozen snapshot, so rehydration never touches Catalog.
function toDomainOrder(row: OrderRow, itemRows: OrderItemRow[]): Order {
  return Order.rehydrate({
    id: row.id,
    userId: row.userId,
    status: row.status,
    currency: row.currency,
    totalAmountMinor: row.totalAmount,
    placedAt: row.placedAt,
    finalizedAt: row.finalizedAt,
    finalizeReason: row.finalizeReason,
    paymentRef: row.paymentRef,
    items: itemRows.map((item) => OrderItem.of(item.skuId, item.productName, item.unitPrice, item.quantity)),
  });
}
