/**
 * The full set of order states — declared in Week 3 even though only a subset of
 * transitions is wired (see order-state-machine.ts). Modelled as a const object +
 * union type (not a TS enum) to avoid enum-comparison lint pitfalls and to keep
 * the string values identical to the `order_status` pg enum in the schema.
 */
export const OrderStatus = {
  /** Snapshotted from the cart, not yet placed. */
  DRAFT: 'DRAFT',
  /** Placed — the seam where reserve/idempotency/outbox attach in later weeks. */
  PENDING: 'PENDING',
  PAID: 'PAID',
  FAILED: 'FAILED',
  EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED',
} as const;

export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];

/** All statuses, in declaration order — the pg enum + exhaustive test iteration use this. */
export const ORDER_STATUSES: readonly OrderStatus[] = Object.values(OrderStatus);
