// Type-only import (tokens file, not the barrel) so the port names Drizzle's tx
// handle without pulling the runtime drizzle module into the application layer.
import type { DrizzleTx } from '@shared/infrastructure/database/drizzle.tokens';

// Stock persistence + reservation port, implemented by the Drizzle adapter in
// infrastructure/. Kept free of drizzle-orm/schema; accepts a `tx` so a reserve
// runs inside the caller's transaction.
export const STOCK_REPOSITORY = Symbol('STOCK_REPOSITORY');

/** One SKU + quantity to hold. */
export interface ReserveLine {
  variantId: string;
  quantity: number;
}

/** Read model of a SKU's stock (available is derived, never stored). */
export interface StockView {
  onHand: number;
  reserved: number;
  available: number;
}

export interface StockRepositoryPort {
  /**
   * Pessimistic hold: `SELECT ... FOR UPDATE` the stock rows inside `tx`, check
   * `available >= qty`, raise reserved, insert HELD reservations. Throws
   * `InsufficientStockError` (→ rollback) when a line doesn't fit.
   */
  reservePessimistic(tx: DrizzleTx, orderId: string, lines: ReserveLine[]): Promise<void>;

  /**
   * Optimistic hold: `UPDATE ... WHERE id=? AND version=?` (+ available guard) inside
   * `tx`, bounded retry on a lost version race, throw `InsufficientStockError` on a
   * real shortfall (no retry).
   */
  reserveOptimistic(tx: DrizzleTx, orderId: string, lines: ReserveLine[]): Promise<void>;

  /** Current on-hand / reserved / available for a SKU; null if the SKU has no stock row. */
  getStockView(variantId: string): Promise<StockView | null>;
}
