import { assertInteger, assertNonEmpty, assertPositive } from '@shared/kernel';
import { ReservationStatus } from './reservation-status';

/**
 * Reservation — one hold of stock for one SKU of one order. Pure domain object,
 * created HELD. `expiresAt` marks when a TTL sweep may release an unpaid hold.
 */
export class Reservation {
  private constructor(
    public readonly orderId: string,
    public readonly variantId: string,
    public readonly quantity: number,
    public readonly status: ReservationStatus,
    public readonly expiresAt: Date | null,
  ) {}

  /** A fresh HELD reservation for `qty` units (qty ≥ 1). */
  static hold(orderId: string, variantId: string, quantity: number, expiresAt: Date | null = null): Reservation {
    assertNonEmpty(orderId, 'Reservation.orderId');
    assertNonEmpty(variantId, 'Reservation.variantId');
    assertInteger(quantity, 'Reservation.quantity');
    assertPositive(quantity, 'Reservation.quantity');
    return new Reservation(orderId, variantId, quantity, ReservationStatus.HELD, expiresAt);
  }

  /** Reconstruct from a persisted row (repository use only). */
  static rehydrate(props: {
    orderId: string;
    variantId: string;
    quantity: number;
    status: ReservationStatus;
    expiresAt: Date | null;
  }): Reservation {
    return new Reservation(props.orderId, props.variantId, props.quantity, props.status, props.expiresAt);
  }
}
