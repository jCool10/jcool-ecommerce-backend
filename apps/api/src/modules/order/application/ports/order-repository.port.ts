import { DomainError } from '@jcool/kernel';
import type { ReserveOutcome } from '../../domain/checkout-saga';
import type { Order } from '../../domain/order.entity';
import type { OrderStatus } from '../../domain/order-status';
import { MAX_PENDING_ORDERS_PER_USER } from '../../order.constants';

export const ORDER_REPOSITORY = Symbol('ORDER_REPOSITORY');

/** Thrown by `createReserving` before the Try, so a refusal leaves no order and no reservation. */
export class TooManyPendingOrdersError extends DomainError {
  constructor(
    public readonly userId: string,
    public readonly pendingCount: number,
  ) {
    super(`User ${userId} already has ${pendingCount} pending orders (max ${MAX_PENDING_ORDERS_PER_USER})`);
    this.name = 'TooManyPendingOrdersError';
  }
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

export interface ReservingCreateResult {
  /** false = an order already carries this key; it is returned as it is now, in any status. */
  created: boolean;
  order: Order;
}

/** `already`: the order is in the target status, nothing was written. `stale`: it is somewhere else. */
export type SagaWriteResult = 'applied' | 'already' | 'stale';

/** `reason` is the rejected order's finalize_reason. */
export type ApplyTryResultInput =
  | { orderId: string; outcome: 'HELD'; reason: null }
  | { orderId: string; outcome: Exclude<ReserveOutcome, 'HELD'>; reason: string };

export interface ApplyOrderChangeInput {
  orderId: string;
  from: OrderStatus[];
  to: OrderStatus;
  reason: string | null;
  paymentRef?: string | null;
}

export interface OrderRepositoryPort {
  /**
   * The saga's first transaction: the order alone, RESERVING, with no hold, event or key flip. An
   * order already under the same key comes back with `created: false`. Serialized per user with
   * `pg_advisory_xact_lock`, then throws `TooManyPendingOrdersError` once the user has the cap of
   * orders still in flight (RESERVING, PENDING, CONFIRMING).
   */
  createReserving(input: { order: Order; idempotencyKey: string | null }): Promise<ReservingCreateResult>;

  /**
   * The saga's second transaction, after the Try answered. HELD moves the order to PENDING, appends
   * `order.placed` and freezes the key with the 201 body; anything else rejects it and clears the
   * order's key, so a retry under the same key places a new order.
   */
  applyTryResult(input: ApplyTryResultInput): Promise<SagaWriteResult>;

  /** One saga status change, compare-and-set on `from`, with the target status's event if it has one. */
  applyOrderChange(input: ApplyOrderChangeInput): Promise<SagaWriteResult>;

  /**
   * Null when the order is absent, someone else's, RESERVING or REJECTED — all indistinguishable, so
   * a buyer cannot probe ids or the saga's internal states.
   */
  findForUser(orderId: string, userId: string): Promise<Order | null>;

  /** Not user-scoped — for cross-context callers that authorize ownership themselves. */
  findById(orderId: string): Promise<Order | null>;

  /** Newest first; leaves out RESERVING and REJECTED, from the page and the total alike. */
  findPageForUser(userId: string, query: OrderPageQuery): Promise<OrderPage>;

  /** RESERVING orders placed before `cutoff`, oldest first. */
  findReservingOlderThan(cutoff: Date, limit: number): Promise<Order[]>;

  /** Deletes up to `limit` REJECTED orders, items included, finalized before `cutoff`. Returns the count. */
  deleteRejectedBefore(cutoff: Date, limit: number): Promise<number>;

  /** The same page unscoped, for the admin queue. A status filter rides `idx_orders_status_placed_at`. */
  findPage(query: AdminOrderPageQuery): Promise<OrderPage>;
}
