/**
 * A const object + union type, not a TS enum, so the string values stay identical to the
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

/** In declaration order — the pg enum and exhaustive test iteration depend on it. */
export const RESERVATION_STATUSES: readonly ReservationStatus[] = Object.values(ReservationStatus);
