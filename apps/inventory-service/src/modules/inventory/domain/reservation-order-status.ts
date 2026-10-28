/** Status of an order's `reservation_orders` header. Declaration order matches the pg enum. */
export const ReservationOrderStatus = {
  HELD: 'HELD',
  COMMITTED: 'COMMITTED',
  RELEASED: 'RELEASED',
  /** Release arrived before any Try; the row exists only to refuse that Try if it shows up later. */
  FENCED: 'FENCED',
  RESTOCKED: 'RESTOCKED',
} as const;

export type ReservationOrderStatus = (typeof ReservationOrderStatus)[keyof typeof ReservationOrderStatus];

export const RESERVATION_ORDER_STATUSES: readonly ReservationOrderStatus[] = Object.values(ReservationOrderStatus);
