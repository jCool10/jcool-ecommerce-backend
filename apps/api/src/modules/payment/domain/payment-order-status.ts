/** Mirrors the `payment_order_status` pg enum, in its declaration order. */
export const PaymentOrderStatus = {
  OPEN: 'OPEN',
  AUTHORIZED: 'AUTHORIZED',
  CAPTURED: 'CAPTURED',
  CANCELLED: 'CANCELLED',
  /** Cancel beat the first open: carries no amount and never a payment, so every later open is refused. */
  FENCED: 'FENCED',
} as const;

export type PaymentOrderStatus = (typeof PaymentOrderStatus)[keyof typeof PaymentOrderStatus];

export const PAYMENT_ORDER_STATUSES: readonly PaymentOrderStatus[] = Object.values(PaymentOrderStatus);

/** Shut by a cancel, after the first open or before it. */
export const CANCELLED_PAYMENT_ORDER_STATUSES: readonly PaymentOrderStatus[] = [
  PaymentOrderStatus.CANCELLED,
  PaymentOrderStatus.FENCED,
];
