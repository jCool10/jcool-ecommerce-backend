import type { DrizzleTx } from '@shared/infrastructure/database/drizzle.tokens';
import type { Order } from '../../domain/order.entity';

// Order persistence port; the Drizzle adapter implements it in infrastructure/.
// Keeps the application free of drizzle-orm/schema. All reads are user-scoped so
// one user can never see another's order (isolation enforced in the query).
export const ORDER_REPOSITORY = Symbol('ORDER_REPOSITORY');

export interface CheckoutPersistResult {
  orderId: string;
  /**
   * true = a fresh order was inserted, reserved, and completed in this transaction.
   * false = an order already carried this idempotency key (a prior attempt committed,
   * then its idempotency row was reclaimed); it is returned untouched for the caller to heal.
   */
  created: boolean;
}

export interface OrderRepositoryPort {
  /**
   * Atomic checkout: in ONE transaction, insert the placed (PENDING) order + its snapshot
   * items, then run `reserve` (the stock hold) and `complete` (the idempotency COMPLETED flip)
   * inside that same transaction, so order + reservation + key commit or roll back together. A
   * shortfall in `reserve` throws and rolls the whole thing back — nothing persists and the
   * client can retry. When `idempotencyKey` already stamps an existing order (crash-reclaim),
   * returns it with `created: false` and runs neither callback (the exit-defense; the unique
   * `orders.idempotency_key` still backstops a lost race at the insert).
   */
  createCheckout(
    order: Order,
    idempotencyKey: string | null,
    reserve: (tx: DrizzleTx, orderId: string) => Promise<void>,
    complete: (tx: DrizzleTx, orderId: string) => Promise<void>,
  ): Promise<CheckoutPersistResult>;

  /**
   * Run `fn` inside one DB transaction, returning its result. The application layer owns the
   * finalize unit of work: it locks the order, applies the domain transition, and persists —
   * plus (later phases) resolves stock and appends the outbox event — all inside this `tx`.
   */
  withTransaction<T>(fn: (tx: DrizzleTx) => Promise<T>): Promise<T>;

  /**
   * Load one order (with items) FOR UPDATE inside `tx`; null if absent. The row lock serializes
   * concurrent finalizers (a duplicate webhook, or a webhook racing the reconcile cron) — the
   * second waits, re-reads the now-terminal row, and no-ops. NOT user-scoped: the caller (Payment
   * webhook / reconcile) authorizes against the aggregate itself.
   */
  findByIdForUpdate(orderId: string, tx: DrizzleTx): Promise<Order | null>;

  /**
   * Persist a finalized order's terminal state (status + finalizedAt/reason/paymentRef) inside `tx`.
   * Called only after the domain transition on a row already locked by `findByIdForUpdate`.
   */
  persistFinalization(order: Order, tx: DrizzleTx): Promise<void>;

  /** One order (with items) owned by `userId`; null if absent or owned by someone else. */
  findForUser(orderId: string, userId: string): Promise<Order | null>;

  /**
   * One order (with items) by id, NOT user-scoped; null if absent. For cross-context callers
   * (e.g. Payment) that authorize ownership themselves against the aggregate's userId.
   */
  findById(orderId: string): Promise<Order | null>;

  /** All of a user's orders (with items), newest first. */
  findAllForUser(userId: string): Promise<Order[]>;
}
