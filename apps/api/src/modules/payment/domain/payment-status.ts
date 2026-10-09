/**
 * Separate from order_status on purpose: a webhook moves the payment, never the order. A const object
 * rather than a TS enum, to dodge enum-comparison lint pitfalls; the string values must stay identical
 * to the `payment_status` pg enum in the schema.
 */
export const PaymentStatus = {
  PENDING: 'PENDING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  /** The session closed without taking money: it lapsed, or a cancel expired it. */
  EXPIRED: 'EXPIRED',
  /** Manual capture only: the money is held, not taken, until capture or void. */
  AUTHORIZED: 'AUTHORIZED',
  /** The hold was released at the gateway; nothing was ever taken. */
  VOIDED: 'VOIDED',
} as const;

export type PaymentStatus = (typeof PaymentStatus)[keyof typeof PaymentStatus];

/** Declaration order — the pg enum and exhaustive test iteration read this. */
export const PAYMENT_STATUSES: readonly PaymentStatus[] = Object.values(PaymentStatus);
