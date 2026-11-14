/** Status of an order's `payment_orders` header. Declaration order matches the pg enum. */
export const PaymentOrderStatus = {
  OPEN: 'OPEN',
  AUTHORIZED: 'AUTHORIZED',
  CAPTURED: 'CAPTURED',
  CANCELLED: 'CANCELLED',
  /** Cancel arrived before any session was opened; the row exists only to refuse one later. */
  FENCED: 'FENCED',
  /** A refund of the captured money is in flight; set before Stripe is called, so it fences a second one. */
  REFUNDING: 'REFUNDING',
  REFUNDED: 'REFUNDED',
  /** Stripe refused or failed the refund, possibly after it had succeeded. The money is owed by hand. */
  REFUND_FAILED: 'REFUND_FAILED',
} as const;

export type PaymentOrderStatus = (typeof PaymentOrderStatus)[keyof typeof PaymentOrderStatus];

export const PAYMENT_ORDER_STATUSES: readonly PaymentOrderStatus[] = Object.values(PaymentOrderStatus);
