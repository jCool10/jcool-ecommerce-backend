// Type-only, from the tokens file rather than the barrel: importing the barrel would pull the
// runtime drizzle module into the application layer.
import type { DrizzleTx } from '@shared/infrastructure/database/drizzle.tokens';
import type {
  ExpiredHold,
  ExpiredHoldQuery,
  ReservationLine,
  StockResolveResult,
} from '../../public/product-stock-reservation.port';

export type { ExpiredHold, ExpiredHoldQuery, ReservationLine, StockResolveResult };

export const STOCK_REPOSITORY = Symbol('STOCK_REPOSITORY');

/** `available` is derived, never stored. */
export interface StockView {
  onHand: number;
  reserved: number;
  available: number;
}

export interface StockRepositoryPort {
  /** Locks the stock rows; throws `InsufficientStockError` on a shortfall, rolling back `tx`. */
  reservePessimistic(tx: DrizzleTx, orderId: string, lines: ReservationLine[]): Promise<void>;

  /**
   * Version-CAS with a bounded retry budget; throws `InsufficientStockError` on a real shortfall.
   * Its idempotency check is NOT lock-guarded: two concurrent reserves for one `orderId` can each
   * raise reserved once, and the surplus hold has no reservation row to release — callers must
   * dedupe order submission upstream.
   */
  reserveOptimistic(tx: DrizzleTx, orderId: string, lines: ReservationLine[]): Promise<void>;

  /** HELD → COMMITTED, dropping both `onHand` and `reserved`. Guarded on HELD, so a re-run is a no-op. */
  commitReservations(tx: DrizzleTx, orderId: string): Promise<StockResolveResult>;

  /** HELD → RELEASED, dropping only `reserved`. Guarded on HELD, so a re-run is a no-op. */
  releaseReservations(tx: DrizzleTx, orderId: string): Promise<StockResolveResult>;

  /** Distinct orders holding HELD stock past `expiredBefore`, oldest expiry first. */
  findExpiredHolds(query: ExpiredHoldQuery): Promise<ExpiredHold[]>;
}
