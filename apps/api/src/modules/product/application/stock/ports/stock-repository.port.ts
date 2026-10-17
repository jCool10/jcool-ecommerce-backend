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

/** `available` is derived, never stored. */
export interface StockView {
  onHand: number;
  reserved: number;
  available: number;
}

export interface StockTransactionOptions {
  /**
   * Wall-clock limit for the whole transaction, counted from the `transaction` call. Every lock wait
   * and statement is cut at the remaining time; running out rolls back and throws
   * `ReservationTimeoutError`. Waiting for a pool connection is not cut, but it spends the limit.
   */
  timeoutMs?: number;
}

export interface HoldOptions {
  /** Defaults to now + `INVENTORY_RESERVATION_TTL`. */
  expiresAt?: Date;
  /** One per line, so the caller can mint them before opening `tx`. Minted here otherwise. */
  reservationIds?: string[];
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

export interface LapsedHeader {
  orderId: string;
  holdUntil: Date;
}

export interface StockRepositoryPort {
  transaction<T>(work: (tx: DrizzleTx) => Promise<T>, options?: StockTransactionOptions): Promise<T>;

  /** Locks the stock rows; throws `InsufficientStockError` on a shortfall, rolling back `tx`. */
  reservePessimistic(tx: DrizzleTx, orderId: string, lines: ReservationLine[], options?: HoldOptions): Promise<void>;

  /**
   * Version-CAS with a bounded retry budget; throws `InsufficientStockError` on a real shortfall and
   * `ReservationConflictError` once the budget is spent. Idempotent per (order, SKU) like the
   * pessimistic path, concurrent duplicates of one order included.
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

  /**
   * False when the order already has a header. A header another transaction inserted but has not
   * committed blocks this call until that one ends.
   */
  insertHeader(tx: DrizzleTx, header: ReservationOrderHeader): Promise<boolean>;

  findHeaderForUpdate(tx: DrizzleTx, orderId: string): Promise<ReservationOrderHeader | null>;

  updateHeader(tx: DrizzleTx, orderId: string, status: ReservationOrderStatus): Promise<void>;

  /** HELD headers past `lapsedBefore`, oldest first. Not locked: re-check each one under its own lock. */
  findLapsedHeaders(query: LapsedHeaderQuery): Promise<LapsedHeader[]>;
}
