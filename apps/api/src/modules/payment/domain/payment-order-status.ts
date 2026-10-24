/** Status of an order's `payment_orders` header. Declaration order matches the pg enum. */
export const PaymentOrderStatus = {
  OPEN: 'OPEN',
  AUTHORIZED: 'AUTHORIZED',
  CAPTURED: 'CAPTURED',
  CANCELLED: 'CANCELLED',
  /** Cancel arrived before any session was opened; the row exists only to refuse one later. */
  FENCED: 'FENCED',
} as const;

export type PaymentOrderStatus = (typeof PaymentOrderStatus)[keyof typeof PaymentOrderStatus];

export const PAYMENT_ORDER_STATUSES: readonly PaymentOrderStatus[] = Object.values(PaymentOrderStatus);
