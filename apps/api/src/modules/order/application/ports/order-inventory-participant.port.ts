import type { CommitOutcome, ParticipantTryOutcome } from '../../domain/checkout-saga';

export const ORDER_INVENTORY_PARTICIPANT = Symbol('ORDER_INVENTORY_PARTICIPANT');

/** Mirrors Inventory's `reservation_orders` header. Declared here so Order never imports Product. */
export type StockHoldStatus = 'HELD' | 'COMMITTED' | 'RELEASED' | 'FENCED' | 'RESTOCKED';

export type StockCommandOutcome = CommitOutcome;

export interface StockTryInput {
  orderId: string;
  lines: { skuId: string; quantity: number }[];
  holdUntil: Date;
}

interface CallOptions {
  /** Aborted when the caller gives up, e.g. a cancelled activity or a worker shutting down. */
  signal?: AbortSignal;
}

/**
 * Stock's TCC participant as the checkout saga sees it. Commands are idempotent per order; business
 * outcomes are returned, transient faults thrown for the caller to retry. A Try that got a definite
 * answer must not be resent.
 */
export interface OrderInventoryParticipantPort {
  tryReserve(input: StockTryInput, options?: CallOptions): Promise<ParticipantTryOutcome>;

  commit(orderId: string, options?: CallOptions): Promise<StockCommandOutcome>;

  /** With no hold yet it fences the order, so a late Try answers CONFLICT. */
  release(orderId: string, options?: CallOptions): Promise<StockCommandOutcome>;

  restock(orderId: string, options?: CallOptions): Promise<StockCommandOutcome>;

  /** Every id asked for gets a key, `null` when stock never heard of the order. */
  statusOf(orderIds: string[], options?: CallOptions): Promise<Map<string, StockHoldStatus | null>>;
}
