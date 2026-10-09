import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, desc, eq, inArray, lt, notInArray, sql, type SQL } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB, type DrizzleTx } from '@shared/infrastructure/database';
import { ID_GENERATOR, type IdGeneratorPort } from '@shared/identity/id-generator.port';
import { Order } from '../domain/order.entity';
import { BUYER_HIDDEN_STATUSES, OPEN_ORDER_STATUSES, OrderStatus } from '../domain/order-status';
import { OrderItem } from '../domain/order-item.entity';
import { MAX_PENDING_ORDERS_PER_USER } from '../order.constants';
import {
  TooManyPendingOrdersError,
  type AdminOrderPageQuery,
  type CreateReservingResult,
  type OrderPage,
  type OrderPageQuery,
  type OrderRepositoryPort,
} from '../application/ports/order-repository.port';
import { orderItems, orders } from './schema/order.schema';

type OrderRow = typeof orders.$inferSelect;
type OrderItemRow = typeof orderItems.$inferSelect;

const visibleToBuyer = notInArray(orders.status, [...BUYER_HIDDEN_STATUSES]);

@Injectable()
export class DrizzleOrderRepository implements OrderRepositoryPort {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGeneratorPort,
  ) {}

  async createReserving<S>(
    order: Order,
    idempotencyKey: string | null,
    insertSaga: (tx: DrizzleTx, orderId: string) => Promise<S>,
  ): Promise<CreateReservingResult<S>> {
    // Before the transaction, so no lock waits on the id service. A replayed key wastes them.
    const [orderId, ...itemIds] = await this.idGenerator.mint(1 + order.items.length);
    return this.db.transaction(async (tx): Promise<CreateReservingResult<S>> => {
      // One checkout per user at a time, so the open-order count below is race-safe.
      await tx.execute(sql`select pg_advisory_xact_lock(${order.userId}::bigint)`);

      if (idempotencyKey) {
        // A prior attempt already placed an order under this key and its idempotency row was then
        // reclaimed. The key's entry gate lets one checkout per key run at a time, so this
        // read-then-insert cannot lose a race; the unique index is the backstop if that ever fails.
        const [existing] = await tx
          .select({ id: orders.id })
          .from(orders)
          .where(and(eq(orders.idempotencyKey, idempotencyKey), eq(orders.userId, order.userId)))
          .limit(1);
        if (existing) {
          return { orderId: existing.id, created: false };
        }
      }

      const [{ value: openCount }] = await tx
        .select({ value: count() })
        .from(orders)
        .where(and(eq(orders.userId, order.userId), inArray(orders.status, [...OPEN_ORDER_STATUSES])));
      if (openCount >= MAX_PENDING_ORDERS_PER_USER) {
        throw new TooManyPendingOrdersError(order.userId, openCount);
      }

      await tx.insert(orders).values({
        id: orderId,
        userId: order.userId,
        status: order.status,
        currency: order.currency,
        totalAmount: order.totalAmountMinor,
        idempotencyKey,
        placedAt: order.placedAt,
      });

      await tx.insert(orderItems).values(
        order.items.map((item, index) => ({
          id: itemIds[index],
          orderId,
          skuId: item.skuId,
          productName: item.productName,
          unitPrice: item.unitPriceMinor,
          quantity: item.quantity,
        })),
      );

      return { orderId, created: true, saga: await insertSaga(tx, orderId) };
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
    return row ? toDomainOrder(row, await this.readItems(tx, orderId)) : null;
  }

  async saveStatus(order: Order, tx: DrizzleTx): Promise<void> {
    if (order.id === null) {
      throw new Error('Cannot save the status of an unsaved order');
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

  async clearIdempotencyKey(orderId: string, tx: DrizzleTx): Promise<void> {
    await tx.update(orders).set({ idempotencyKey: null }).where(eq(orders.id, orderId));
  }

  async findForUser(orderId: string, userId: string): Promise<Order | null> {
    const [row] = await this.db
      .select()
      .from(orders)
      .where(and(eq(orders.id, orderId), eq(orders.userId, userId), visibleToBuyer))
      .limit(1);
    return row ? toDomainOrder(row, await this.readItems(this.db, orderId)) : null;
  }

  async findById(orderId: string): Promise<Order | null> {
    const [row] = await this.db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    return row ? toDomainOrder(row, await this.readItems(this.db, orderId)) : null;
  }

  findPageForUser(userId: string, query: OrderPageQuery): Promise<OrderPage> {
    return this.readPage(and(eq(orders.userId, userId), visibleToBuyer), query);
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

  async deleteRejectedBefore(cutoff: Date, limit: number): Promise<number> {
    // Items and the saga row go with the order through their ON DELETE CASCADE.
    const batch = this.db
      .select({ id: orders.id })
      .from(orders)
      .where(and(eq(orders.status, OrderStatus.REJECTED), lt(orders.finalizedAt, cutoff)))
      .orderBy(asc(orders.finalizedAt))
      .limit(limit);
    const deleted = await this.db.delete(orders).where(inArray(orders.id, batch)).returning({ id: orders.id });
    return deleted.length;
  }

  private readItems(db: DrizzleDB | DrizzleTx, orderId: string): Promise<OrderItemRow[]> {
    return db
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, orderId))
      .orderBy(orderItems.createdAt, orderItems.id);
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
