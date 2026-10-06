import type { ReservationLine } from './product-stock-reservation.port';

export const INVENTORY_PARTICIPANT = Symbol('INVENTORY_PARTICIPANT');

export type TryReserveOutcome = 'HELD' | 'OUT_OF_STOCK' | 'CONTENDED' | 'CONFLICT';
export type CommitOutcome = 'COMMITTED' | 'CONFLICT';
export type ReleaseOutcome = 'RELEASED' | 'FENCED' | 'CONFLICT';
export type RestockOutcome = 'RESTOCKED' | 'CONFLICT';

export interface TryReserveInput {
  orderId: string;
  /** At most one line per `variantId`; ignored on a repeat Try. */
  lines: ReservationLine[];
  /** Past it, stock's own sweep releases the hold. */
  holdUntil: Date;
}

export interface TryReserveResult {
  outcome: TryReserveOutcome;
  /** For logs only; never show it to the buyer. */
  detail?: string;
}

/**
 * Idempotent behind a per-order fence, so calls may arrive in any order. Outcomes are returned; a throw
 * means unknown (retry, or release a Try). `OUT_OF_STOCK` and `CONTENDED` are final: never Try again.
 */
export interface InventoryParticipant {
  tryReserve(input: TryReserveInput): Promise<TryReserveResult>;
  commit(orderId: string): Promise<{ outcome: CommitOutcome }>;
  release(orderId: string): Promise<{ outcome: ReleaseOutcome }>;
  restock(orderId: string): Promise<{ outcome: RestockOutcome }>;
}
