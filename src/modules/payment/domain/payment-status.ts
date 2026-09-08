/**
 * Separate from order_status on purpose: a webhook moves the payment, never the order. A const object
 * rather than a TS enum, to dodge enum-comparison lint pitfalls; the string values must stay identical
 * to the `payment_status` pg enum in the schema.
 */
export const PaymentStatus = {
  PENDING: 'PENDING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  /** Session lapsed without an outcome; set by the reconciliation sweep, never by a webhook. */
  EXPIRED: 'EXPIRED',
} as const;

export type PaymentStatus = (typeof PaymentStatus)[keyof typeof PaymentStatus];

/** What a gateway event can settle a payment to — EXPIRED belongs to the sweep alone. */
export type SettledPaymentStatus = typeof PaymentStatus.SUCCEEDED | typeof PaymentStatus.FAILED;

/** Declaration order — the pg enum and exhaustive test iteration read this. */
export const PAYMENT_STATUSES: readonly PaymentStatus[] = Object.values(PaymentStatus);
