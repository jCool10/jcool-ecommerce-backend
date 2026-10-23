import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { and, asc, count, desc, eq, inArray, lt, sql, type SQL } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB, type DrizzleTx } from '@shared/infrastructure/database';
import { ID_GENERATOR, type IdGeneratorPort } from '@shared/identity/id-generator.port';
import { OUTBOX_WRITER, type OutboxWriterPort } from '@shared/messaging/outbox/outbox-writer.port';
import { Order } from '../domain/order.entity';
import { OrderStatus } from '../domain/order-status';
import { OrderItem } from '../domain/order-item.entity';
import { MAX_PENDING_ORDERS_PER_USER } from '../order.constants';
import {
  TooManyPendingOrdersError,
  type AdminOrderPageQuery,
  type ApplyOrderChangeInput,
  type ApplyTryResultInput,
  type CheckoutPersistResult,
  type OrderPage,
  type OrderPageQuery,
  type OrderRepositoryPort,
  type ReservingCreateResult,
  type SagaWriteResult,
  type StalePendingOrder,
} from '../application/ports/order-repository.port';
import {
  IDEMPOTENCY_STORE,
  userIdempotencyScope,
  type IdempotencyStorePort,
} from '../application/ports/idempotency-store.port';
import { toFinalizedOutboxRecord, toPlacedOutboxRecord } from '../application/order-outbox.mapper';
import { toView } from '../application/order-view.mapper';
import { orderItems, orders } from './schema/order.schema';

type OrderRow = typeof orders.$inferSelect;
type OrderItemRow = typeof orderItems.$inferSelect;

const IN_FLIGHT_STATUSES = [OrderStatus.RESERVING, OrderStatus.PENDING, OrderStatus.CONFIRMING];

@Injectable()
export class DrizzleOrderRepository implements OrderRepositoryPort {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGeneratorPort,
    @Inject(OUTBOX_WRITER) private readonly outboxWriter: OutboxWriterPort,
    @Inject(IDEMPOTENCY_STORE) private readonly idempotencyStore: IdempotencyStorePort,
  ) {}

  async createCheckout(
    order: Order,
    idempotencyKey: string | null,
    reserve: (tx: DrizzleTx, orderId: string) => Promise<void>,
    appendEvent: (tx: DrizzleTx, orderId: string) => Promise<void>,
    complete: (tx: DrizzleTx, orderId: string) => Promise<void>,
  ): Promise<CheckoutPersistResult> {
    // Before the transaction, so no lock waits on the id service. A replayed key wastes them.
    const [orderId, ...itemIds] = await this.idGenerator.mint(1 + order.items.length);
    return this.db.transaction(async (tx) => {
      // One checkout per user at a time, so the pending count below is race-safe. Taken before any
      // stock row lock, so it cannot cycle with them.
      await tx.execute(sql`select pg_advisory_xact_lock(${order.userId}::bigint)`);

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

      const [{ value: pendingCount }] = await tx
        .select({ value: count() })
        .from(orders)
        .where(and(eq(orders.userId, order.userId), eq(orders.status, OrderStatus.PENDING)));
      if (pendingCount >= MAX_PENDING_ORDERS_PER_USER) {
        throw new TooManyPendingOrdersError(order.userId, pendingCount);
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

      // Same tx as the insert above, so there can be no placed order without its event and no event
      // for an order that never committed. The event goes first because appending mints an id, and
      // `reserve` takes the stock row locks every other checkout queues on. `complete` is last: any
      // earlier failure aborts before the idempotency key is marked COMPLETED.
      await appendEvent(tx, orderId);
      await reserve(tx, orderId);
      await complete(tx, orderId);
      return { orderId, created: true };
    });
  }

  async createReserving({
    order,
    idempotencyKey,
  }: {
    order: Order;
    idempotencyKey: string | null;
  }): Promise<ReservingCreateResult> {
    const [orderId, ...itemIds] = await this.idGenerator.mint(1 + order.items.length);
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${order.userId}::bigint)`);

      if (idempotencyKey) {
        const [existing] = await tx
          .select()
          .from(orders)
          .where(and(eq(orders.idempotencyKey, idempotencyKey), eq(orders.userId, order.userId)))
          .limit(1);
        if (existing) {
          return { created: false, order: toDomainOrder(existing, await this.itemRowsOf(existing.id, tx)) };
        }
      }

      const [{ value: inFlight }] = await tx
        .select({ value: count() })
        .from(orders)
        .where(and(eq(orders.userId, order.userId), inArray(orders.status, IN_FLIGHT_STATUSES)));
      if (inFlight >= MAX_PENDING_ORDERS_PER_USER) {
        throw new TooManyPendingOrdersError(order.userId, inFlight);
      }

      await tx.insert(orders).values({
        id: orderId,
        userId: order.userId,
        status: order.status,
        currency: order.currency,
        totalAmount: order.totalAmountMinor,
        idempotencyKey,
        placedAt: order.placedAt,
        paymentDeadlineAt: order.paymentDeadlineAt,
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
      return { created: true, order: withId(order, orderId) };
    });
  }

  async applyTryResult(input: ApplyTryResultInput): Promise<SagaWriteResult> {
    const target = input.outcome === 'HELD' ? OrderStatus.PENDING : OrderStatus.REJECTED;
    // Only a placed order emits an event. Minted up front so the row lock never waits on the id service.
    const outboxId = target === OrderStatus.PENDING ? (await this.idGenerator.mint(1))[0] : undefined;

    return this.db.transaction(async (tx) => {
      const locked = await this.lockOrder(input.orderId, tx);
      if (!locked) return 'stale';
      const { order, idempotencyKey } = locked;
      if (order.status === target) return 'already';
      if (order.status !== OrderStatus.RESERVING) return 'stale';

      if (input.outcome !== 'HELD') {
        const rejected = order.reject(input.reason, new Date());
        // Clearing the key lets a retry under it place a fresh order instead of replaying this one.
        await tx
          .update(orders)
          .set({
            status: rejected.status,
            finalizedAt: rejected.finalizedAt,
            finalizeReason: rejected.finalizeReason,
            idempotencyKey: null,
          })
          .where(eq(orders.id, input.orderId));
        return 'applied';
      }

      const placed = order.confirmPlaced();
      await tx.update(orders).set({ status: placed.status }).where(eq(orders.id, input.orderId));
      await this.outboxWriter.append(tx, toPlacedOutboxRecord(placed.toPlacedEvent()), { id: outboxId });
      if (idempotencyKey !== null) {
        await this.idempotencyStore.markCompleted(
          {
            scope: userIdempotencyScope(placed.userId),
            key: idempotencyKey,
            responseStatus: HttpStatus.CREATED,
            responseBody: toView(placed),
            orderId: input.orderId,
          },
          tx,
        );
      }
      return 'applied';
    });
  }

  async applyOrderChange({ orderId, from, to, reason, paymentRef }: ApplyOrderChangeInput): Promise<SagaWriteResult> {
    const emitsEvent = to !== OrderStatus.CONFIRMING;
    const outboxId = emitsEvent ? (await this.idGenerator.mint(1))[0] : undefined;

    return this.db.transaction(async (tx) => {
      const locked = await this.lockOrder(orderId, tx);
      if (!locked) return 'stale';
      const { order } = locked;
      if (order.status === to) return 'already';
      if (!from.includes(order.status)) return 'stale';

      const changed = moveForSaga(order, to, { now: new Date(), reason, paymentRef });
      await this.persistFinalization(changed, tx);
      if (emitsEvent) {
        await this.outboxWriter.append(tx, toFinalizedOutboxRecord(changed.toFinalizedEvent()), { id: outboxId });
      }
      return 'applied';
    });
  }

  async withTransaction<T>(fn: (tx: DrizzleTx) => Promise<T>, join?: DrizzleTx): Promise<T> {
    // Reused as-is rather than nested: a nested drizzle transaction is a SAVEPOINT, which would let
    // this unit roll back on its own and leave the caller's — the inbox claim, say — committed.
    return join ? fn(join) : this.db.transaction(fn);
  }

  async findByIdForUpdate(orderId: string, tx: DrizzleTx): Promise<Order | null> {
    return (await this.lockOrder(orderId, tx))?.order ?? null;
  }

  // The order row only: items are immutable snapshots, so they need no lock.
  private async lockOrder(
    orderId: string,
    tx: DrizzleTx,
  ): Promise<{ order: Order; idempotencyKey: string | null } | null> {
    const [row] = await tx.select().from(orders).where(eq(orders.id, orderId)).for('update').limit(1);
    if (!row) {
      return null;
    }
    return { order: toDomainOrder(row, await this.itemRowsOf(orderId, tx)), idempotencyKey: row.idempotencyKey };
  }

  private itemRowsOf(orderId: string, tx: DrizzleTx): Promise<OrderItemRow[]> {
    return tx
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, orderId))
      .orderBy(orderItems.createdAt, orderItems.id);
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
    paymentDeadlineAt: row.paymentDeadlineAt,
    items: itemRows.map((item) => OrderItem.of(item.skuId, item.productName, item.unitPrice, item.quantity)),
  });
}

function withId(order: Order, id: string): Order {
  return Order.rehydrate({ ...order, id, items: [...order.items] });
}

function moveForSaga(
  order: Order,
  to: OrderStatus,
  meta: { now: Date; reason: string | null; paymentRef?: string | null },
): Order {
  switch (to) {
    case OrderStatus.CONFIRMING:
      return order.beginConfirming();
    case OrderStatus.PAID:
    case OrderStatus.FAILED:
    case OrderStatus.EXPIRED:
    case OrderStatus.CANCELLED:
      return order.finalize(to, meta);
    default:
      throw new Error(`A saga order change cannot target ${to}`);
  }
}
