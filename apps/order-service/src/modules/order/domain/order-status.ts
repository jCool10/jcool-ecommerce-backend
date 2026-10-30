/**
 * A const object + union type rather than a TS enum, to avoid enum-comparison lint pitfalls. The
 * string values must stay identical to the `order_status` pg enum in the schema.
 *
 * No imports, on purpose: the checkout saga workflow bundles this file, and its bundler resolves
 * neither path aliases nor anything that touches Node.
 */
export const OrderStatus = {
  /** Snapshotted from the cart, not yet placed. */
  DRAFT: 'DRAFT',
  /** Placed; the saga's stock Try has not answered yet. */
  RESERVING: 'RESERVING',
  PENDING: 'PENDING',
  /** Authorization verified; stock commit and capture are under way. */
  CONFIRMING: 'CONFIRMING',
  PAID: 'PAID',
  FAILED: 'FAILED',
  EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED',
  /** The Try refused or ran out of time: never placed, nothing to compensate on the order. */
  REJECTED: 'REJECTED',
} as const;

export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];

/** In declaration order — the pg enum and the exhaustive tests both rely on it. */
export const ORDER_STATUSES: readonly OrderStatus[] = Object.values(OrderStatus);
