/**
 * Payment-side status — separate from order_status on purpose (a webhook moves the
 * payment, never the order). Modelled as a const object + union type (not a TS enum) to
 * dodge enum-comparison lint pitfalls and keep the string values identical to the
 * `payment_status` pg enum in the schema.
 */
export const PaymentStatus = {
  /** Session created; awaiting the gateway's outcome. */
  PENDING: 'PENDING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  /** Session lapsed without an outcome (set by reconciliation, not yet wired). */
  EXPIRED: 'EXPIRED',
} as const;

export type PaymentStatus = (typeof PaymentStatus)[keyof typeof PaymentStatus];

/** All statuses, in declaration order — the pg enum + exhaustive test iteration use this. */
export const PAYMENT_STATUSES: readonly PaymentStatus[] = Object.values(PaymentStatus);
