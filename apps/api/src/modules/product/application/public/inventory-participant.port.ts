import type { ReservationLine } from './product-stock-reservation.port';

export const INVENTORY_PARTICIPANT = Symbol('INVENTORY_PARTICIPANT');

export type TryReserveOutcome = 'HELD' | 'OUT_OF_STOCK' | 'CONTENDED' | 'CONFLICT';
export type CommitOutcome = 'COMMITTED' | 'CONFLICT';
export type ReleaseOutcome = 'RELEASED' | 'FENCED' | 'CONFLICT';
export type RestockOutcome = 'RESTOCKED' | 'CONFLICT';

export interface TryReserveInput {
  orderId: string;
  /** At most one line per `variantId`. Ignored when the order is already held. */
  lines: ReservationLine[];
  /** Stock's own sweep releases the hold after this. The orchestrator owns the value. */
  holdUntil: Date;
}

export interface TryReserveResult {
  outcome: TryReserveOutcome;
  /** For logs only, never for the buyer. */
  detail?: string;
}

/**
 * The checkout saga's stock participant. Each call runs its own transaction behind a per-order
 * fence, so calls for one order may arrive in any order and any number of times.
 *
 * A returned outcome is final. A throw means the outcome is unknown: retry it, or for a Try, release.
 * `OUT_OF_STOCK` and `CONTENDED` leave nothing behind, and the orchestrator must never Try that order
 * again after either.
 */
export interface InventoryParticipant {
  tryReserve(input: TryReserveInput): Promise<TryReserveResult>;
  commit(orderId: string): Promise<{ outcome: CommitOutcome }>;
  release(orderId: string): Promise<{ outcome: ReleaseOutcome }>;
  restock(orderId: string): Promise<{ outcome: RestockOutcome }>;
}
