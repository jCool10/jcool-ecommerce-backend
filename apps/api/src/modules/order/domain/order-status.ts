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
  // Appended, never inserted: `ALTER TYPE ... ADD VALUE` can only append without rewriting the type.
  /** Placed, while the stock Try is out; hidden from the buyer. */
  RESERVING: 'RESERVING',
  /** The Try failed or never answered; hidden from the buyer. */
  REJECTED: 'REJECTED',
  /** Authorized; stock commit and capture are under way, so the buyer can no longer cancel. */
  CONFIRMING: 'CONFIRMING',
} as const;

export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];

/** In declaration order — the pg enum and the exhaustive tests both rely on it. */
export const ORDER_STATUSES: readonly OrderStatus[] = Object.values(OrderStatus);

/** Counted against the per-user cap: each one still holds, or may still hold, stock. */
export const OPEN_ORDER_STATUSES: readonly OrderStatus[] = [
  OrderStatus.RESERVING,
  OrderStatus.PENDING,
  OrderStatus.CONFIRMING,
];

/** A buyer never sees these: one is still being placed, the other never was. */
export const BUYER_HIDDEN_STATUSES: readonly OrderStatus[] = [OrderStatus.RESERVING, OrderStatus.REJECTED];
