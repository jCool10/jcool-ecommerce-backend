// Payment's own read language for an order; the adapter implements it against Order's published
// ORDER_PAYMENT_VIEW, so the use cases here carry no Order import.
export const ORDER_READ_PORT = Symbol('ORDER_READ_PORT');

/** How Payment sees an order: identity + owner (for its own authz) + the frozen chargeable total. */
export interface OrderView {
  id: string;
  userId: string;
  status: string;
  amountMinor: number;
  currency: string;
}

export interface StalePendingOrderView {
  id: string;
  placedAt: Date;
}

export interface OrderReadPort {
  /** The order to be paid, by id; null if no such order. Ownership is checked by the caller. */
  findForPayment(orderId: string): Promise<OrderView | null>;

  /** The sweep's work queue; the `placedBefore` filter is what keeps it off webhooks still in flight. */
  findStalePending(input: { placedBefore: Date; limit: number }): Promise<StalePendingOrderView[]>;
}
