import { OrderStatus } from '../../domain/order-status';
import type { FinalizeOutcome, OrderFinalizedEvent } from '../../domain/order.entity';
import type { Order } from '../../domain/order.entity';

export type { FinalizeOutcome };

export const FINALIZE_OUTCOMES: readonly FinalizeOutcome[] = [
  OrderStatus.PAID,
  OrderStatus.FAILED,
  OrderStatus.EXPIRED,
];

export interface FinalizeInput {
  orderId: string;
  outcome: FinalizeOutcome;
  /** Audit reason stamped on the order, e.g. 'webhook:failed', 'reconcile:paid'. */
  reason?: string | null;
  paymentRef?: string | null;
}

/**
 * `noop` = the same outcome re-applied to a terminal order; `ignored` = a conflicting outcome, or an
 * order not in PENDING. Neither regresses the order, and neither produces a second event.
 */
export type FinalizeStatus = 'finalized' | 'noop' | 'ignored' | 'not_found';

export interface FinalizeResult {
  status: FinalizeStatus;
  /** The order after the call; absent only for `not_found`. */
  order?: Order;
  /** Present only on `finalized`, produced exactly once. Nothing publishes it yet. */
  event?: OrderFinalizedEvent;
}
