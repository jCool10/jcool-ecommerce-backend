import { DomainError } from '@shared/kernel';
// Type-only, from the tokens file rather than the barrel: importing the barrel would pull the
// runtime drizzle module into the application layer.
import type { DrizzleTx } from '@shared/infrastructure/database/drizzle.tokens';

// The ONLY way another context holds stock; bound to ReserveStockUseCase, whose strategy is config.
export const STOCK_RESERVATION = Symbol('STOCK_RESERVATION');

export interface ReservationLine {
  variantId: string;
  quantity: number;
}

/**
 * The one failure type a cross-context caller maps, translated from Inventory's domain errors at the
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

export interface StockReservation {
  /** Holds inside the caller's `tx`, so the hold commits or rolls back with it. */
  reserve(tx: DrizzleTx, orderId: string, lines: ReservationLine[]): Promise<void>;

  /** Payment succeeded: on-hand drops for real. Idempotent, and never throws — the result says what happened. */
  commit(tx: DrizzleTx, orderId: string): Promise<StockResolveResult>;

  /** The hold is given up: the held quantity returns to available. Same contract as `commit`. */
  release(tx: DrizzleTx, orderId: string): Promise<StockResolveResult>;

  /**
   * Orders whose hold has lapsed, oldest first. Inventory reports the lapse and nothing more: only
   * the order's own context may decide it is over.
   */
  findExpiredHolds(query: ExpiredHoldQuery): Promise<ExpiredHold[]>;
}
