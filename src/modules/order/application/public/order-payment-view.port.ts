/**
 * Order's published read language for the Payment context — a cross-context surface
 * (importable from another bounded context, per `.dependency-cruiser.cjs`). Returns a
 * plain snapshot, never the Order aggregate or a row. Carries `userId` so Payment can
 * authorize ownership itself, and the frozen total so the session amount is the order's
 * truth (never a client-supplied figure).
 */
export const ORDER_PAYMENT_VIEW = Symbol('ORDER_PAYMENT_VIEW');

/** Minimal projection of one order needed to start a payment. */
export interface OrderPaymentSnapshot {
  id: string;
  userId: string;
  /** The order_status value ('DRAFT' | 'PENDING' | 'PAID' | ...); Payment only starts on PENDING. */
  status: string;
  /** Frozen order total in smallest currency units. */
  totalAmountMinor: number;
  currency: string;
}

export interface OrderPaymentView {
  /** One order by id (not user-scoped — Payment does its own ownership check); null if absent. */
  findForPayment(orderId: string): Promise<OrderPaymentSnapshot | null>;
}
