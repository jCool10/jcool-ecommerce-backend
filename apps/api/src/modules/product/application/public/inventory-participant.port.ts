import type { ReservationOrderStatus } from '../../domain/stock/reservation-order-status';
import type { ReservationLine } from './product-stock-reservation.port';

export const INVENTORY_PARTICIPANT = Symbol('INVENTORY_PARTICIPANT');

export type { ReservationLine, ReservationOrderStatus };

export type TryReserveOutcome = 'RESERVED' | 'OUT_OF_STOCK' | 'CONTENDED' | 'CONFLICT';

export type ParticipantCommandOutcome = 'APPLIED' | 'IDEMPOTENT' | 'CONFLICT';

export interface TryReserveInput {
  orderId: string;
  lines: ReservationLine[];
  /** Stamped on every line's `expires_at`; the lapsed-hold sweep releases the order after it. */
  holdUntil: Date;
}

/**
 * Stock's TCC participant. Each command opens its own transaction and is idempotent per order, fenced
 * by the order's `reservation_orders` header. Business outcomes are returned; a timeout, a DB fault or
 * an id-service fault is thrown, and the caller retries it. Stock never decides the order's outcome.
 *
 * The orchestrator must not resend a Try after a definite answer: OUT_OF_STOCK and CONTENDED leave no
 * header behind, so a resent Try could reserve where the first one refused.
 */
export interface InventoryParticipant {
  tryReserve(input: TryReserveInput): Promise<TryReserveOutcome>;

  commit(orderId: string): Promise<ParticipantCommandOutcome>;

  /** A release with no header yet writes FENCED and answers APPLIED; any later Try gets CONFLICT. */
  release(orderId: string): Promise<ParticipantCommandOutcome>;

  /** Compensates a commit: on-hand goes back up. */
  restock(orderId: string): Promise<ParticipantCommandOutcome>;

  /** One lock-free read for the whole batch; every id asked for gets a key, `null` when it has no header. */
  statusOf(orderIds: string[]): Promise<Map<string, ReservationOrderStatus | null>>;
}
