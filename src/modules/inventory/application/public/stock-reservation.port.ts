import { DomainError } from '@shared/kernel';
// Type-only (tokens file, not the barrel) so the published port names Drizzle's tx
// handle without pulling the runtime drizzle module into the application layer.
import type { DrizzleTx } from '@shared/infrastructure/database/drizzle.tokens';

// Inventory's published stock-reservation surface — the ONLY way another context holds
// stock. Bound to ReserveStockUseCase (strategy chosen by config) and exported by
// InventoryModule. Cross-context callers depend on this, never on Inventory internals.
export const STOCK_RESERVATION = Symbol('STOCK_RESERVATION');

/** One SKU + quantity to hold (Inventory's published reservation language). */
export interface ReservationLine {
  variantId: string;
  quantity: number;
}

/**
 * Published failure of a stock hold: `OUT_OF_STOCK` is a real shortfall,
 * `CONTENDED` is an exhausted optimistic-retry budget under concurrency. A single
 * published type (translated from Inventory's domain errors at the boundary) so a
 * cross-context caller maps a reservation failure to one client status without
 * reaching into Inventory's domain. The message carries the SKU/quantities and is
 * safe to surface — no internals.
 */
export class StockReservationError extends DomainError {
  constructor(
    message: string,
    public readonly reason: 'OUT_OF_STOCK' | 'CONTENDED',
  ) {
    super(message);
    this.name = 'StockReservationError';
  }
}

/**
 * Outcome of committing or releasing an order's reservations.
 * - `applied`         — at least one HELD reservation was transitioned (stock moved).
 * - `alreadyResolved` — reservations existed but none were HELD (a prior commit/release already ran).
 * - `count`           — how many reservations this call transitioned (0 unless `applied`).
 *
 * `applied:false, alreadyResolved:false` means the order had no reservations at all — a data anomaly
 * for a PAID order (it predates holds, or the hold was lost), surfaced by the caller for reconciliation.
 */
export interface StockResolveResult {
  applied: boolean;
  alreadyResolved: boolean;
  count: number;
}

export interface StockReservation {
  /**
   * Hold stock for an order's lines inside the caller's `tx`, so the hold commits or
   * rolls back with the caller's unit of work. Throws `StockReservationError` when a
   * line can't be held.
   */
  reserve(tx: DrizzleTx, orderId: string, lines: ReservationLine[]): Promise<void>;

  /**
   * Commit an order's holds inside the caller's `tx` (payment succeeded): HELD → COMMITTED, dropping
   * both on-hand and reserved for each held line (goods ship for real). Idempotent — a re-run moves no
   * stock. Never throws for a missing/already-resolved reservation; the result says what happened.
   */
  commit(tx: DrizzleTx, orderId: string): Promise<StockResolveResult>;

  /**
   * Release an order's holds inside the caller's `tx` (payment failed / expired): HELD → RELEASED,
   * returning each held quantity to available (on-hand untouched). Idempotent, non-throwing — same
   * contract as `commit`.
   */
  release(tx: DrizzleTx, orderId: string): Promise<StockResolveResult>;
}
