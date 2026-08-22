/**
 * Order's published read language for Payment — a cross-context surface per `.dependency-cruiser.cjs`.
 * Snapshots only, never the aggregate: `userId` lets Payment authorize ownership itself, and the
 * frozen total keeps the session amount the order's truth rather than a client-supplied figure.
 */
export const ORDER_PAYMENT_VIEW = Symbol('ORDER_PAYMENT_VIEW');

export interface OrderPaymentSnapshot {
  id: string;
  userId: string;
  /** The order_status value; Payment only starts a session on PENDING. */
  status: string;
  /** Frozen order total, in smallest currency units. */
  totalAmountMinor: number;
  currency: string;
}

export interface StalePendingOrderSnapshot {
  id: string;
  placedAt: Date;
}

export interface OrderPaymentView {
  /** One order by id (not user-scoped — Payment does its own ownership check); null if absent. */
  findForPayment(orderId: string): Promise<OrderPaymentSnapshot | null>;

  /** The work queue for Payment's sweep; orders a finalize currently holds are skipped, not queued. */
  findStalePending(input: { placedBefore: Date; limit: number }): Promise<StalePendingOrderSnapshot[]>;
}
