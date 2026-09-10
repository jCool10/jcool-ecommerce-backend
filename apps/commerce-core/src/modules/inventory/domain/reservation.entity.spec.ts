import { describe, expect, it } from 'vitest';
import { Reservation } from './reservation.entity';
import { ReservationStatus } from './reservation-status';

describe('Reservation entity', () => {
  it('hold() builds a HELD reservation for the given quantity', () => {
    const r = Reservation.hold('order-1', 'sku-a', 2);
    expect(r.status).toBe(ReservationStatus.HELD);
    expect(r.orderId).toBe('order-1');
    expect(r.variantId).toBe('sku-a');
    expect(r.quantity).toBe(2);
    expect(r.expiresAt).toBeNull();
  });

  it('hold() carries an expiry when provided', () => {
    const at = new Date('2026-01-01T00:00:00.000Z');
    expect(Reservation.hold('order-1', 'sku-a', 1, at).expiresAt).toBe(at);
  });

  it('hold() rejects a non-positive or fractional quantity', () => {
    expect(() => Reservation.hold('order-1', 'sku-a', 0)).toThrow();
    expect(() => Reservation.hold('order-1', 'sku-a', -1)).toThrow();
    expect(() => Reservation.hold('order-1', 'sku-a', 1.5)).toThrow();
  });

  it('hold() rejects empty ids', () => {
    expect(() => Reservation.hold('', 'sku-a', 1)).toThrow();
    expect(() => Reservation.hold('order-1', '', 1)).toThrow();
  });
});
