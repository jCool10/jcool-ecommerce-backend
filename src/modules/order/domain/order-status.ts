/**
 * A const object + union type rather than a TS enum, to avoid enum-comparison lint pitfalls. The
 * string values must stay identical to the `order_status` pg enum in the schema.
 */
export const OrderStatus = {
  /** Snapshotted from the cart, not yet placed. */
  DRAFT: 'DRAFT',
  PENDING: 'PENDING',
  PAID: 'PAID',
  FAILED: 'FAILED',
  EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED',
} as const;

export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];

/** In declaration order — the pg enum and the exhaustive tests both rely on it. */
export const ORDER_STATUSES: readonly OrderStatus[] = Object.values(OrderStatus);
