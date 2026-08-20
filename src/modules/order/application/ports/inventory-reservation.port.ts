// Type-only (tokens file, not the barrel) so the port names Drizzle's tx handle
// without pulling the runtime drizzle module into the application layer.
import type { DrizzleTx } from '@shared/infrastructure/database/drizzle.tokens';

/**
 * Order's need for holding stock at placement. Order OWNS this port (the abstraction);
 * Inventory supplies the concrete adapter, wired at the module boundary. Placing an
 * order calls `reserve(tx, ...)` inside the placement transaction so the hold and the
 * DRAFT → PENDING status flip commit or roll back together (atomic order ↔ stock).
 */
export const INVENTORY_RESERVATION = Symbol('INVENTORY_RESERVATION');

/** One line to reserve stock for (Order speaks `skuId`; the adapter maps it to the variant). */
export interface ReservationLine {
  skuId: string;
  quantity: number;
}

/**
 * What resolving an order's hold did. `applied` — stock moved; `alreadyResolved` — a prior
 * commit/release already ran (no-op); both false — the order had no hold at all (an anomaly for a
 * PAID order, logged for reconciliation). Finalization proceeds regardless — resolution never throws.
 */
export interface StockResolution {
  applied: boolean;
  alreadyResolved: boolean;
  count: number;
}

export interface InventoryReservationPort {
  /**
   * Reserve stock for the given lines inside the caller's `tx`. A shortfall (or an
   * exhausted retry budget under contention) throws Inventory's published
   * `StockReservationError`, which rolls back the whole transaction — the order stays
   * DRAFT and stock is untouched.
   */
  reserve(tx: DrizzleTx, orderId: string, lines: ReservationLine[]): Promise<void>;

  /**
   * Commit the order's hold inside the finalize `tx` (PAID): HELD → COMMITTED, on-hand drops for real.
   * Idempotent and non-throwing so the finalize transaction settles order + stock atomically.
   */
  commit(tx: DrizzleTx, orderId: string): Promise<StockResolution>;

  /**
   * Release the order's hold inside the finalize `tx` (FAILED/EXPIRED): HELD → RELEASED, stock returns
   * to available. Idempotent and non-throwing — same contract as `commit`.
   */
  release(tx: DrizzleTx, orderId: string): Promise<StockResolution>;
}
