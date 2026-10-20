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
   * Epoch ms for the whole transaction. Every statement that can wait on a lock is limited to what is
   * left of it, and running out throws `ReservationTimeoutError`.
   */
  deadline?: number;
}

/** Omitted fields keep the legacy behaviour: expiry from the configured TTL, ids minted inside the tx. */
export interface HoldOptions {
  expiresAt?: Date;
  /** One per line, minted by the caller before its transaction opened. */
  reservationIds?: string[];
}

export interface ReservationOrderHeader {
  status: ReservationOrderStatus;
  holdUntil: Date | null;
}

export interface StockRepositoryPort {
  transaction<T>(work: (tx: DrizzleTx) => Promise<T>, options?: StockTransactionOptions): Promise<T>;

  /** Locks the stock rows; throws `InsufficientStockError` on a shortfall, rolling back `tx`. */
  reservePessimistic(tx: DrizzleTx, orderId: string, lines: ReservationLine[], options?: HoldOptions): Promise<void>;

  /**
   * Version-CAS with a bounded retry budget; throws `InsufficientStockError` on a real shortfall and
   * `ReservationConflictError` once the budget is spent. Idempotent per (order, SKU) like the
   * pessimistic path, concurrent duplicates of one order included. On the participant path the order's
   * header lock already serializes duplicates before they reach this.
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

  /** Inserts a HELD header; false when the order already has one. */
  insertHeader(tx: DrizzleTx, input: { orderId: string; holdUntil: Date }): Promise<boolean>;

  /** Inserts a FENCED header; false when the order already has one. */
  insertFencedHeader(tx: DrizzleTx, orderId: string): Promise<boolean>;

  findHeaderForUpdate(tx: DrizzleTx, orderId: string): Promise<ReservationOrderHeader | null>;

  /** Locks the header only if it is still HELD past `hold_until`, skipping one another tx holds. */
  lockLapsedHeader(tx: DrizzleTx, orderId: string): Promise<boolean>;

  setHeaderStatus(tx: DrizzleTx, orderId: string, status: ReservationOrderStatus): Promise<void>;

  /** HELD headers past `hold_until`, oldest first. Unlocked read; the caller re-checks under the lock. */
  findLapsedHeaderIds(query: { limit: number }): Promise<string[]>;

  /** Outside any transaction and lock-free. Orders without a header are simply absent from the map. */
  findHeaderStatuses(orderIds: string[]): Promise<Map<string, ReservationOrderStatus>>;
}
