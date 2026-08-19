// Payment's own read language for an order — the infrastructure adapter implements it against
// Order's published ORDER_PAYMENT_VIEW. Keeps the session use case free of any Order import: it
// depends only on this port, so it's unit-testable with a fake and unaware of the Order context.
export const ORDER_READ_PORT = Symbol('ORDER_READ_PORT');

/** How Payment sees an order: identity + owner (for its own authz) + the frozen chargeable total. */
export interface OrderView {
  id: string;
  userId: string;
  status: string;
  amountMinor: number;
  currency: string;
}

export interface OrderReadPort {
  /** The order to be paid, by id; null if no such order. Ownership is checked by the caller. */
  findForPayment(orderId: string): Promise<OrderView | null>;
}
