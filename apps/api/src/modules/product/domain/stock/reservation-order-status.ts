/** Mirrors the `reservation_order_status` pg enum, in declaration order. */
export const ReservationOrderStatus = {
  HELD: 'HELD',
  COMMITTED: 'COMMITTED',
  RELEASED: 'RELEASED',
  /** Released before any Try landed: holds nothing, and a late Try is refused. */
  FENCED: 'FENCED',
  RESTOCKED: 'RESTOCKED',
} as const;

export type ReservationOrderStatus = (typeof ReservationOrderStatus)[keyof typeof ReservationOrderStatus];

export const RESERVATION_ORDER_STATUSES: readonly ReservationOrderStatus[] = Object.values(ReservationOrderStatus);
