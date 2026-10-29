import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { and, asc, count, desc, eq, gte, inArray, isNotNull, lt, lte, notInArray, sql, type SQL } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB, type DrizzleTx } from '@shared/infrastructure/database';
import { ID_GENERATOR, type IdGeneratorPort } from '@shared/identity/id-generator.port';
import { OUTBOX_WRITER, type OutboxWriterPort } from '@jcool/messaging/outbox-port';
import { Order } from '../domain/order.entity';
import { OrderStatus } from '../domain/order-status';
import { OrderItem } from '../domain/order-item.entity';
import { MAX_PENDING_ORDERS_PER_USER } from '../order.constants';
import {
  TooManyPendingOrdersError,
  type AdminOrderPageQuery,
  type ApplyOrderChangeInput,
  type ApplyTryResultInput,
  type OrderPage,
  type OrderPageQuery,
  type OrderRepositoryPort,
  type ReservingCreateResult,
  type SagaWriteResult,
  type SettledSagaOrder,
  type SettledSagaOrderCursor,
} from '../application/ports/order-repository.port';
import { TERMINAL_SAGA_STATUSES } from '../domain/checkout-invariants';
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
// Never placed as far as the buyer knows: every buyer read answers as if the order did not exist.
const HIDDEN_FROM_BUYER = [OrderStatus.RESERVING, OrderStatus.REJECTED];
const visibleToBuyer = (userId: string) => and(eq(orders.userId, userId), notInArray(orders.status, HIDDEN_FROM_BUYER));

@Injectable()
export class DrizzleOrderRepository implements OrderRepositoryPort {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGeneratorPort,
    @Inject(OUTBOX_WRITER) private readonly outboxWriter: OutboxWriterPort,
    @Inject(IDEMPOTENCY_STORE) private readonly idempotencyStore: IdempotencyStorePort,
  ) {}

  async createReserving({
    order,
    idempotencyKey,
  }: {
    order: Order;
    idempotencyKey: string | null;
  }): Promise<ReservingCreateResult> {
    // Before the transaction, so no lock waits on the id service. A replayed key wastes them.
    const [orderId, ...itemIds] = await this.idGenerator.mint(1 + order.items.length);
    return this.db.transaction(async (tx) => {
      // One checkout per user at a time, so the in-flight count below is race-safe.
      await tx.execute(sql`select pg_advisory_xact_lock(${order.userId}::bigint)`);

      if (idempotencyKey) {
        // Exit-defense for a key whose idempotency row was reclaimed after its order committed. The
        // key's entry gate already serializes this read-then-insert; the unique column backstops it.
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
      await this.writeStatusChange(changed, tx);
      if (emitsEvent) {
        await this.outboxWriter.append(tx, toFinalizedOutboxRecord(changed.toFinalizedEvent()), { id: outboxId });
      }
      return 'applied';
    });
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

  private async writeStatusChange(order: Order, tx: DrizzleTx): Promise<void> {
    if (order.id === null) {
      throw new Error('Cannot write a status change for an unsaved order');
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
      .where(and(eq(orders.id, orderId), visibleToBuyer(userId)))
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
    return this.readPage(visibleToBuyer(userId), query);
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
        return { items: await this.withItems(orderRows, tx), total };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }

  async findReservingOlderThan(cutoff: Date, limit: number): Promise<Order[]> {
    const rows = await this.db
      .select()
      .from(orders)
      .where(and(eq(orders.status, OrderStatus.RESERVING), lt(orders.placedAt, cutoff)))
      .orderBy(asc(orders.placedAt), asc(orders.id))
      .limit(limit);
    return this.withItems(rows, this.db);
  }

  async findTerminalSagaOrdersInWindow(
    { from, to }: { from: Date; to: Date },
    after: SettledSagaOrderCursor | null,
    limit: number,
  ): Promise<SettledSagaOrder[]> {
    // Keyed at the cursor's millisecond precision: on a microsecond stamp written by SQL, a cursor
    // read back as a Date would sort before its own row and return the same page forever.
    const finalizedMs = sql`date_trunc('milliseconds', ${orders.finalizedAt})`;
    const rows = await this.db
      .select({ id: orders.id, status: orders.status, finalizedAt: finalizedMs.mapWith(orders.finalizedAt) })
      .from(orders)
      .where(
        and(
          inArray(orders.status, [...TERMINAL_SAGA_STATUSES]),
          isNotNull(orders.paymentDeadlineAt),
          gte(orders.finalizedAt, from),
          lte(orders.finalizedAt, to),
          after
            ? sql`(${finalizedMs}, ${orders.id}) > (${after.finalizedAt.toISOString()}::timestamptz, ${after.id})`
            : undefined,
        ),
      )
      .orderBy(asc(finalizedMs), asc(orders.id))
      .limit(limit);
    return rows as SettledSagaOrder[];
  }

  async deleteRejectedBefore(cutoff: Date, limit: number): Promise<number> {
    // No LIMIT on DELETE in Postgres, so the batch comes from a subquery; order_items cascade.
    const doomed = this.db
      .select({ id: orders.id })
      .from(orders)
      .where(and(eq(orders.status, OrderStatus.REJECTED), lt(orders.finalizedAt, cutoff)))
      .limit(limit);
    const deleted = await this.db.delete(orders).where(inArray(orders.id, doomed)).returning({ id: orders.id });
    return deleted.length;
  }

  private async withItems(orderRows: OrderRow[], db: DrizzleDB | DrizzleTx): Promise<Order[]> {
    if (orderRows.length === 0) {
      return [];
    }
    const itemRows = await db
      .select()
      .from(orderItems)
      .where(
        inArray(
          orderItems.orderId,
          orderRows.map(({ id }) => id),
        ),
      )
      .orderBy(orderItems.createdAt, orderItems.id);

    const itemsByOrder = new Map<string, OrderItemRow[]>();
    for (const item of itemRows) {
      const bucket = itemsByOrder.get(item.orderId) ?? [];
      bucket.push(item);
      itemsByOrder.set(item.orderId, bucket);
    }
    return orderRows.map((row) => toDomainOrder(row, itemsByOrder.get(row.id) ?? []));
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
