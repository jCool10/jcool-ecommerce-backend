import { OrderStatus } from '../../domain/order-status';
import type { FinalizeOutcome, OrderFinalizedEvent } from '../../domain/order.entity';
import type { Order } from '../../domain/order.entity';

export type { FinalizeOutcome };

/** The terminal outcomes finalization accepts — the wired PENDING → { PAID, FAILED, EXPIRED } edges. */
export const FINALIZE_OUTCOMES: readonly FinalizeOutcome[] = [
  OrderStatus.PAID,
  OrderStatus.FAILED,
  OrderStatus.EXPIRED,
];

export interface FinalizeInput {
  orderId: string;
  outcome: FinalizeOutcome;
  /** Human/audit reason stamped on the order (e.g. 'webhook:failed', 'reconcile:paid', 'expired'). */
  reason?: string | null;
  /** Gateway transaction id, when a paid outcome carried one. */
  paymentRef?: string | null;
}

/**
 * - `finalized` — the effect ran exactly once (status flipped, event produced).
 * - `noop`      — same outcome re-applied to an already-terminal order; nothing changed, no second event.
 * - `ignored`   — a conflicting outcome, or an order not in PENDING; skipped without regress (logged for reconcile).
 * - `not_found` — no order with that id.
 */
export type FinalizeStatus = 'finalized' | 'noop' | 'ignored' | 'not_found';

export interface FinalizeResult {
  status: FinalizeStatus;
  /** The order after the call (absent only for `not_found`). */
  order?: Order;
  /** Present only on `finalized` — the domain event, produced exactly once (a later phase publishes it). */
  event?: OrderFinalizedEvent;
}
