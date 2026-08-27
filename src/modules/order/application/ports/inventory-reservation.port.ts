// Type-only, from the tokens file rather than the barrel: importing the barrel would pull the
// runtime drizzle module into the application layer.
import type { DrizzleTx } from '@shared/infrastructure/database/drizzle.tokens';

/**
 * Order owns this abstraction; Inventory supplies the adapter, wired at the module boundary. The
 * hold runs inside the placement transaction, so stock and the DRAFT → PENDING flip commit together.
 */
export const INVENTORY_RESERVATION = Symbol('INVENTORY_RESERVATION');

/** Order speaks `skuId`; the adapter maps it to Inventory's variant. */
export interface ReservationLine {
  skuId: string;
  quantity: number;
}

/** Both false = the order had no hold at all — an anomaly for a PAID order, logged by the caller. */
export interface StockResolution {
  applied: boolean;
  alreadyResolved: boolean;
  count: number;
}

export interface InventoryReservationPort {
  /** A shortfall throws `StockReservationError`, rolling back `tx`: the order stays DRAFT, stock untouched. */
  reserve(tx: DrizzleTx, orderId: string, lines: ReservationLine[]): Promise<void>;

  /** PAID: on-hand drops for real. Idempotent and non-throwing, so finalize settles order + stock atomically. */
  commit(tx: DrizzleTx, orderId: string): Promise<StockResolution>;

  /** Any outcome other than PAID: stock returns to available. Same contract as `commit`. */
  release(tx: DrizzleTx, orderId: string): Promise<StockResolution>;
}
