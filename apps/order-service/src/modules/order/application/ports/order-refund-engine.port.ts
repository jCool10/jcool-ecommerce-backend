export const ORDER_REFUND_ENGINE = Symbol('ORDER_REFUND_ENGINE');

/**
 * How the order's refund run ended, or `RUNNING` when it outlived the wait. `requestedBy` is the
 * admin whose run it is: a caller who joined someone else's run reads another id here.
 */
export type RefundRunResult =
  | { outcome: 'REFUNDED'; requestedBy: string }
  | { outcome: 'REFUND_FAILED'; reason: string | null; requestedBy: string }
  | { outcome: 'NOT_REFUNDABLE'; requestedBy: string }
  | { outcome: 'RUNNING' };

/** Throws CheckoutEngineUnavailableError when the run's start could not be confirmed in time. */
export interface OrderRefundEnginePort {
  /** Starts the order's refund run, or joins the one already open, and waits for it up to its budget. */
  refund(orderId: string, requestedBy: string): Promise<RefundRunResult>;
}
