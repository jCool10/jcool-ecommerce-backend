import { DomainError } from '@jcool/kernel';
import type { DrizzleTx } from '@shared/infrastructure/database/drizzle.tokens';
import type { Order } from '../../domain/order.entity';
import type { OrderStatus } from '../../domain/order-status';
import { MAX_PENDING_ORDERS_PER_USER } from '../../order.constants';

export const ORDER_REPOSITORY = Symbol('ORDER_REPOSITORY');

/** Thrown by `createReserving` before any stock is asked for, so a refusal leaves nothing behind. */
export class TooManyPendingOrdersError extends DomainError {
  constructor(
    public readonly userId: string,
    public readonly pendingCount: number,
  ) {
    super(`User ${userId} already has ${pendingCount} pending orders (max ${MAX_PENDING_ORDERS_PER_USER})`);
    this.name = 'TooManyPendingOrdersError';
  }
}

/** `created: false`: an earlier attempt already placed an order under the same key; returned untouched. */
export type CreateReservingResult<S> =
  { orderId: string; created: true; saga: S } | { orderId: string; created: false };

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
   * Inserts the RESERVING order and, through `insertSaga`, its saga in one transaction. Serialized per
   * user with `pg_advisory_xact_lock` before counting the user's open orders, throwing
   * `TooManyPendingOrdersError` at the cap. An existing order under the same key returns
   * `created: false` without calling `insertSaga`; the unique `(user_id, idempotency_key)` still
   * backstops a race that slips past that check.
   */
  createReserving<S>(
    order: Order,
    idempotencyKey: string | null,
    insertSaga: (tx: DrizzleTx, orderId: string) => Promise<S>,
  ): Promise<CreateReservingResult<S>>;

  /**
   * A caller that already holds a transaction passes it in and `fn` joins it, so a write driven from
   * a message commits or rolls back with that message's inbox claim.
   */
  withTransaction<T>(fn: (tx: DrizzleTx) => Promise<T>, join?: DrizzleTx): Promise<T>;

  /** Locked before the saga row, everywhere, so the two cannot deadlock. Not user-scoped. */
  findByIdForUpdate(orderId: string, tx: DrizzleTx): Promise<Order | null>;

  /** Status and settlement stamps; only ever called on a row locked by `findByIdForUpdate`. */
  saveStatus(order: Order, tx: DrizzleTx): Promise<void>;

  /** Frees the key of a rejected order, so a retry under it places a new one. */
  clearIdempotencyKey(orderId: string, tx: DrizzleTx): Promise<void>;

  /** Null when absent, owned by someone else, or not yet visible to the buyer. */
  findForUser(orderId: string, userId: string): Promise<Order | null>;

  /** Not user-scoped, and sees every status — for callers that authorize and filter themselves. */
  findById(orderId: string): Promise<Order | null>;

  /** Newest first, buyer-visible statuses only. */
  findPageForUser(userId: string, query: OrderPageQuery): Promise<OrderPage>;

  /** The same page unscoped and unfiltered, for the admin queue: a scan the page size bounds. */
  findPage(query: AdminOrderPageQuery): Promise<OrderPage>;

  /** Deletes up to `limit` REJECTED orders finalized before `cutoff`, with their items and saga. */
  deleteRejectedBefore(cutoff: Date, limit: number): Promise<number>;
}
