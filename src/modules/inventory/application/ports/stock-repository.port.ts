// Type-only import (tokens file, not the barrel) so the port names Drizzle's tx
// handle without pulling the runtime drizzle module into the application layer.
import type { DrizzleTx } from '@shared/infrastructure/database/drizzle.tokens';
import type { StockResolveResult } from '../public/stock-reservation.port';

export type { StockResolveResult };

// Stock persistence + reservation port, implemented by the Drizzle adapter in
// infrastructure/. Kept free of drizzle-orm/schema; accepts a `tx` so a reserve
// runs inside the caller's transaction.
export const STOCK_REPOSITORY = Symbol('STOCK_REPOSITORY');

/**
 * One SKU + quantity to hold. Callers pass at most one line per `variantId` (the
 * cart enforces one row per SKU); a duplicate variant would be held once, not summed.
 */
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
   *
   * Unlike the pessimistic path, the idempotency check is not lock-guarded: two
   * concurrent reserves for the same `orderId` can each raise reserved once (never an
   * oversell — the available guard + CHECK still cap it — but the surplus hold has no
   * reservation row to release). Callers must dedupe order submission (single-flight
   * per order, or an idempotency key upstream).
   */
  reserveOptimistic(tx: DrizzleTx, orderId: string, lines: ReserveLine[]): Promise<void>;

  /**
   * Commit an order's HELD reservations inside `tx` (payment succeeded): HELD → COMMITTED, and for each
   * held line drop BOTH `onHand` and `reserved` by its quantity (goods ship for real; `available` is
   * unchanged). Guarded on `status='HELD'` so a re-run moves no stock. Locks stock rows in `variantId`
   * order to match `reserve` and rule out a cross-order deadlock.
   */
  commitReservations(tx: DrizzleTx, orderId: string): Promise<StockResolveResult>;

  /**
   * Release an order's HELD reservations inside `tx` (payment failed / expired): HELD → RELEASED, drop
   * `reserved` by each held quantity (`onHand` untouched — stock returns to available). Guarded on
   * `status='HELD'`; same deterministic lock order as `commitReservations`.
   */
  releaseReservations(tx: DrizzleTx, orderId: string): Promise<StockResolveResult>;

  /** Current on-hand / reserved / available for a SKU; null if the SKU has no stock row. */
  getStockView(variantId: string): Promise<StockView | null>;
}
