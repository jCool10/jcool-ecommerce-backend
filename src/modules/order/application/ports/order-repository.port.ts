import type { DrizzleTx } from '@shared/infrastructure/database/drizzle.tokens';
import type { Order } from '../../domain/order.entity';

// Order persistence port; the Drizzle adapter implements it in infrastructure/. Reads split into
// user-scoped (`findForUser`/`findAllForUser`) and unscoped, which cross-context callers authorize.
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

export interface OrderRepositoryPort {
  /**
   * Order + stock hold + idempotency flip commit or roll back together, in one transaction. An
   * existing order under the same key returns `created: false` and runs neither callback; the
   * unique `orders.idempotency_key` still backstops a race that slips past that check.
   */
  createCheckout(
    order: Order,
    idempotencyKey: string | null,
    reserve: (tx: DrizzleTx, orderId: string) => Promise<void>,
    complete: (tx: DrizzleTx, orderId: string) => Promise<void>,
  ): Promise<CheckoutPersistResult>;

  /** Run `fn` in one transaction — the application layer owns the finalize unit of work. */
  withTransaction<T>(fn: (tx: DrizzleTx) => Promise<T>): Promise<T>;

  /**
   * The row lock that serializes concurrent finalizers: the second waits, re-reads the now-terminal
   * row, and no-ops. Not user-scoped — the caller authorizes against the aggregate itself.
   */
  findByIdForUpdate(orderId: string, tx: DrizzleTx): Promise<Order | null>;

  /** Only ever called on a row already locked by `findByIdForUpdate`. */
  persistFinalization(order: Order, tx: DrizzleTx): Promise<void>;

  /** One order (with items) owned by `userId`; null if absent or owned by someone else. */
  findForUser(orderId: string, userId: string): Promise<Order | null>;

  /** Not user-scoped — for cross-context callers that authorize ownership themselves. */
  findById(orderId: string): Promise<Order | null>;

  findAllForUser(userId: string): Promise<Order[]>;

  /**
   * The reconciliation sweep's work queue, read `FOR UPDATE SKIP LOCKED` so it never queues behind a
   * finalize in progress. The lock lasts only for the statement, so two sweeps can still pick the
   * same order — finalize's terminal guard, not this read, is what makes that harmless.
   */
  findStalePending(input: { placedBefore: Date; limit: number }): Promise<StalePendingOrder[]>;
}
