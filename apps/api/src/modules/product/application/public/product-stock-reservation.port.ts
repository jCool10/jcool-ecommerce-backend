import { DomainError } from '@jcool/kernel';
// Type-only, from the tokens file rather than the barrel: importing the barrel would pull the
// runtime drizzle module into the application layer.
import type { DrizzleTx } from '@shared/infrastructure/database/drizzle.tokens';

// Legacy checkout's in-transaction hold; the saga uses INVENTORY_PARTICIPANT instead.
export const PRODUCT_STOCK_RESERVATION = Symbol('PRODUCT_STOCK_RESERVATION');

/** At most one line per `variantId` — a duplicate variant is held once, not summed. */
export interface ReservationLine {
  variantId: string;
  quantity: number;
}

/**
 * The one failure type a cross-context caller maps, translated from stock's domain errors at the
 * boundary: `OUT_OF_STOCK` is a real shortfall, `CONTENDED` an exhausted optimistic-retry budget.
 * The message carries SKU and quantities only — safe to surface.
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

/** Both false = the order had no reservations at all — an anomaly for a PAID order, logged by the caller. */
export interface StockResolveResult {
  applied: boolean;
  alreadyResolved: boolean;
  count: number;
}

export interface ExpiredHold {
  orderId: string;
  expiresAt: Date;
}

export interface ExpiredHoldQuery {
  expiredBefore: Date;
  /** Caps reservation ROWS read, not orders — a multi-line order collapses to a single entry. */
  limit: number;
}

export interface ProductStockReservation {
  /** Holds inside the caller's `tx`, so the hold commits or rolls back with it. */
  reserve(tx: DrizzleTx, orderId: string, lines: ReservationLine[]): Promise<void>;

  /** Payment succeeded: on-hand drops for real. Idempotent, and never throws — the result says what happened. */
  commit(tx: DrizzleTx, orderId: string): Promise<StockResolveResult>;

  /** The hold is given up: the held quantity returns to available. Same contract as `commit`. */
  release(tx: DrizzleTx, orderId: string): Promise<StockResolveResult>;

  /**
   * Orders whose hold has lapsed, oldest first. Stock reports the lapse and nothing more: only
   * the order's own context may decide it is over.
   */
  findExpiredHolds(query: ExpiredHoldQuery): Promise<ExpiredHold[]>;
}
