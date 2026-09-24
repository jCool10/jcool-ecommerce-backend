import { describe, expect, it } from 'vitest';
import { PaymentStatus } from '../../domain/payment-status';
import { mapPaymentToOrderOutcome } from './map-payment-to-order-outcome';

describe('mapPaymentToOrderOutcome', () => {
  // Order EXPIRED belongs to the reservation sweep; an expired session arrives here as FAILED.
  it('finalizes an order only from a succeeded or failed payment, never to EXPIRED', () => {
    const statuses = [PaymentStatus.SUCCEEDED, PaymentStatus.FAILED, PaymentStatus.PENDING, PaymentStatus.EXPIRED];

    expect(statuses.map(mapPaymentToOrderOutcome)).toEqual(['PAID', 'FAILED', null, null]);
  });
});
