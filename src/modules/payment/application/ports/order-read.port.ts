// The adapter implements this against Order's published ORDER_PAYMENT_VIEW, so the use cases here
// carry no Order import.
export const ORDER_READ_PORT = Symbol('ORDER_READ_PORT');

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
  /** Ownership is checked by the caller. */
  findForPayment(orderId: string): Promise<OrderView | null>;

  /** The `placedBefore` filter is what keeps the sweep off webhooks still in flight. */
  findStalePending(input: { placedBefore: Date; limit: number }): Promise<StalePendingOrderView[]>;
}
