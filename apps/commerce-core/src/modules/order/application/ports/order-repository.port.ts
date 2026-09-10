import type { DrizzleTx } from '@shared/infrastructure/database/drizzle.tokens';
import type { Order } from '../../domain/order.entity';
import type { OrderStatus } from '../../domain/order-status';

export const ORDER_REPOSITORY = Symbol('ORDER_REPOSITORY');

export interface CheckoutPersistResult {
  orderId: string;
  /** false = an earlier attempt already committed this order under the same key; returned untouched. */
  created: boolean;
}

export interface StalePendingOrder {
  id: string;
  placedAt: Date;
}

export interface OrderPageQuery {
  /** 1-based. */
  page: number;
  pageSize: number;
}

export interface AdminOrderPageQuery extends OrderPageQuery {
  status?: OrderStatus;
  userId?: string;
}

export interface OrderPage {
  items: Order[];
  /** Rows matching the filter, not rows on this page — the client needs it to know there are more. */
  total: number;
}

export interface OrderRepositoryPort {
  /**
   * Order + stock hold + outbox event + idempotency flip commit or roll back together, in one
   * transaction. An existing order under the same key returns `created: false` and runs none of the
   * callbacks; the unique `orders.idempotency_key` still backstops a race that slips past that
   * check. `appendEvent` runs only for a genuinely new order — a reclaim heal re-emits nothing.
   */
  createCheckout(
    order: Order,
    idempotencyKey: string | null,
    reserve: (tx: DrizzleTx, orderId: string) => Promise<void>,
    appendEvent: (tx: DrizzleTx, orderId: string) => Promise<void>,
    complete: (tx: DrizzleTx, orderId: string) => Promise<void>,
  ): Promise<CheckoutPersistResult>;

  /**
   * Run `fn` in one transaction — the application layer owns the finalize unit of work. A caller
   * that already holds one passes it in and `fn` joins it instead, so a finalize driven from a
   * message commits or rolls back with whatever else that transaction is protecting.
   */
  withTransaction<T>(fn: (tx: DrizzleTx) => Promise<T>, join?: DrizzleTx): Promise<T>;

  /**
   * The row lock that serializes concurrent finalizers: the second waits, re-reads the now-terminal
   * row, and no-ops. Not user-scoped — the caller authorizes against the aggregate itself.
   */
  findByIdForUpdate(orderId: string, tx: DrizzleTx): Promise<Order | null>;

  /** Only ever called on a row already locked by `findByIdForUpdate`. */
  persistFinalization(order: Order, tx: DrizzleTx): Promise<void>;

  /** Null when the order is absent or owned by someone else — the two are indistinguishable. */
  findForUser(orderId: string, userId: string): Promise<Order | null>;

  /** Not user-scoped — for cross-context callers that authorize ownership themselves. */
  findById(orderId: string): Promise<Order | null>;

  /** Newest first. */
  findPageForUser(userId: string, query: OrderPageQuery): Promise<OrderPage>;

  /**
   * The same page unscoped, for the admin queue. Filtering by status has no index to use
   * (`idx_orders_pending_placed_at` is partial on PENDING), so it is a scan the page size bounds.
   */
  findPage(query: AdminOrderPageQuery): Promise<OrderPage>;

  /**
   * The reconciliation sweep's work queue, read `FOR UPDATE SKIP LOCKED` so it never queues behind a
   * finalize in progress. The lock lasts only for the statement, so two sweeps can still pick the
   * same order — finalize's terminal guard, not this read, is what makes that harmless.
   */
  findStalePending(input: { placedBefore: Date; limit: number }): Promise<StalePendingOrder[]>;
}
