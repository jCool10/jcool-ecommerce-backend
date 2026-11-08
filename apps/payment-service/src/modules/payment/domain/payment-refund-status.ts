/** Status of an order's `payment_refunds` row. Declaration order matches the pg enum. */
export const PaymentRefundStatus = {
  PENDING: 'PENDING',
  SUCCEEDED: 'SUCCEEDED',
  /** Terminal, and reachable from SUCCEEDED: Stripe can fail a refund days after reporting it done. */
  FAILED: 'FAILED',
} as const;

export type PaymentRefundStatus = (typeof PaymentRefundStatus)[keyof typeof PaymentRefundStatus];
