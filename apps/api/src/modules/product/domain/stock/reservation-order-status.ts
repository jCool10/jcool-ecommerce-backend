/** Mirrors the `reservation_order_status` pg enum, in its declaration order. */
export const ReservationOrderStatus = {
  HELD: 'HELD',
  COMMITTED: 'COMMITTED',
  RELEASED: 'RELEASED',
  /** Release beat the Try: holds nothing, so a late Try refuses. */
  FENCED: 'FENCED',
  RESTOCKED: 'RESTOCKED',
} as const;

export type ReservationOrderStatus = (typeof ReservationOrderStatus)[keyof typeof ReservationOrderStatus];

export const RESERVATION_ORDER_STATUSES: readonly ReservationOrderStatus[] = Object.values(ReservationOrderStatus);
