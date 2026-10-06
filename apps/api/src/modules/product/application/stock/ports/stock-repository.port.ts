// Type-only, from the tokens file rather than the barrel: importing the barrel would pull the
// runtime drizzle module into the application layer.
import type { DrizzleTx } from '@shared/infrastructure/database/drizzle.tokens';
import type { ReservationOrderStatus } from '../../../domain/stock/reservation-order-status';
import type {
  ExpiredHold,
  ExpiredHoldQuery,
  ReservationLine,
  StockResolveResult,
} from '../../public/product-stock-reservation.port';

export type { ExpiredHold, ExpiredHoldQuery, ReservationLine, StockResolveResult };

export const STOCK_REPOSITORY = Symbol('STOCK_REPOSITORY');

export type LockStrategy = 'pessimistic' | 'optimistic';

/** `available` is derived, never stored. */
export interface StockView {
  onHand: number;
  reserved: number;
  available: number;
}

export interface ReservationOrderHeader {
  orderId: string;
  status: ReservationOrderStatus;
  holdUntil: Date | null;
}

export interface LapsedHeaderQuery {
  lapsedBefore: Date;
  limit: number;
}

export interface LapsedHold {
  orderId: string;
  holdUntil: Date;
}

export interface StockTransactionOptions {
  /** Bound on the whole transaction, pool wait included; running out throws `ReservationTimeoutError`. */
  timeoutMs?: number;
}

export interface HoldOptions {
  /** Defaults to now + `INVENTORY_RESERVATION_TTL`. */
  expiresAt?: Date;
  /** One per line; omitted, the hold mints its own while `tx` is open. */
  reservationIds?: string[];
}

export interface StockRepositoryPort {
  transaction<T>(work: (tx: DrizzleTx) => Promise<T>, options?: StockTransactionOptions): Promise<T>;

  /** Locks the stock rows; throws `InsufficientStockError` on a shortfall, rolling back `tx`. */
  reservePessimistic(tx: DrizzleTx, orderId: string, lines: ReservationLine[], options?: HoldOptions): Promise<void>;

  /**
   * Version-CAS with a bounded retry budget; throws `InsufficientStockError` on a real shortfall.
   * Its idempotency check is NOT lock-guarded: two concurrent reserves for one `orderId` can each
   * raise reserved once, and the surplus hold has no reservation row to release — callers must
   * dedupe order submission upstream.
   */
  reserveOptimistic(tx: DrizzleTx, orderId: string, lines: ReservationLine[], options?: HoldOptions): Promise<void>;

  /** HELD → COMMITTED, dropping both `onHand` and `reserved`. Guarded on HELD, so a re-run is a no-op. */
  commitReservations(tx: DrizzleTx, orderId: string): Promise<StockResolveResult>;

  /** HELD → RELEASED, dropping only `reserved`. Guarded on HELD, so a re-run is a no-op. */
  releaseReservations(tx: DrizzleTx, orderId: string): Promise<StockResolveResult>;

  /** COMMITTED → RESTOCKED, raising `onHand` back. Guarded on COMMITTED, so a re-run is a no-op. */
  restockReservations(tx: DrizzleTx, orderId: string): Promise<StockResolveResult>;

  /** Distinct orders holding HELD stock past `expiredBefore`, oldest expiry first. */
  findExpiredHolds(query: ExpiredHoldQuery): Promise<ExpiredHold[]>;

  /** False only when a committed header exists; waits on a concurrent uncommitted insert. */
  insertHeader(tx: DrizzleTx, header: ReservationOrderHeader): Promise<boolean>;

  findHeaderForUpdate(tx: DrizzleTx, orderId: string): Promise<ReservationOrderHeader | null>;

  updateHeader(tx: DrizzleTx, orderId: string, status: ReservationOrderStatus): Promise<void>;

  /** Not locked past this statement: re-check each header under the caller's own lock. */
  findLapsedHeaders(query: LapsedHeaderQuery): Promise<LapsedHold[]>;
}
