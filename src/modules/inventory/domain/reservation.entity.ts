import { assertInteger, assertNonEmpty, assertPositive } from '@shared/kernel';
import { ReservationStatus } from './reservation-status';

// `expiresAt` marks when a TTL sweep may release an unpaid hold.
export class Reservation {
  private constructor(
    public readonly orderId: string,
    public readonly variantId: string,
    public readonly quantity: number,
    public readonly status: ReservationStatus,
    public readonly expiresAt: Date | null,
  ) {}

  static hold(orderId: string, variantId: string, quantity: number, expiresAt: Date | null = null): Reservation {
    assertNonEmpty(orderId, 'Reservation.orderId');
    assertNonEmpty(variantId, 'Reservation.variantId');
    assertInteger(quantity, 'Reservation.quantity');
    assertPositive(quantity, 'Reservation.quantity');
    return new Reservation(orderId, variantId, quantity, ReservationStatus.HELD, expiresAt);
  }

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
