import type { DrizzleTx } from '@shared/infrastructure/database/drizzle.tokens';
import type { Order } from '../../domain/order.entity';
import type { OrderStatus } from '../../domain/order-status';

// Order persistence port; the Drizzle adapter implements it in infrastructure/.
// Keeps the application free of drizzle-orm/schema. All reads are user-scoped so
// one user can never see another's order (isolation enforced in the query).
export const ORDER_REPOSITORY = Symbol('ORDER_REPOSITORY');

export interface OrderRepositoryPort {
  /** Insert a DRAFT order + its snapshot items in one transaction; returns the new id. */
  create(order: Order): Promise<string>;

  /** One order (with items) owned by `userId`; null if absent or owned by someone else. */
  findForUser(orderId: string, userId: string): Promise<Order | null>;

  /** All of a user's orders (with items), newest first. */
  findAllForUser(userId: string): Promise<Order[]>;

  /**
   * Atomically move an order `expectedStatus → PENDING`, stamping `placedAt`, in a
   * transaction, running `reserve` (the stock hold) inside that SAME transaction.
   * Returns false if no row matched (already placed / lost race) — `reserve` never
   * runs in that case, so nothing is held. When the status flip wins, `reserve` runs;
   * if it throws, the whole transaction rolls back, leaving the order DRAFT and stock
   * untouched. Outbox (BF#4) hooks into the same seam later.
   */
  markPlaced(
    orderId: string,
    userId: string,
    expectedStatus: OrderStatus,
    placedAt: Date,
    reserve: (tx: DrizzleTx) => Promise<void>,
  ): Promise<boolean>;
}
