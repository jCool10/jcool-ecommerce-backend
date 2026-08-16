/**
 * Reservation lifecycle states. Modelled as a const object + union type (not a TS
 * enum) to match OrderStatus and keep the string values identical to the
 * `reservation_status` pg enum. Declaration order matches that pg enum.
 */
export const ReservationStatus = {
  /** Stock held: `quantityReserved` raised, `quantityOnHand` unchanged. */
  HELD: 'HELD',
  /** Hold released (payment failed / expired) → stock given back. */
  RELEASED: 'RELEASED',
  /** Hold committed (payment succeeded) → stock leaves for real. */
  COMMITTED: 'COMMITTED',
} as const;

export type ReservationStatus = (typeof ReservationStatus)[keyof typeof ReservationStatus];

/** All statuses, in declaration order — the pg enum + exhaustive test iteration use this. */
export const RESERVATION_STATUSES: readonly ReservationStatus[] = Object.values(ReservationStatus);
