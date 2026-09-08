import { describe, expect, it } from 'vitest';
import { PaymentStatus } from '../../domain/payment-status';
import { mapPaymentToOrderOutcome } from './map-payment-to-order-outcome';

describe('mapPaymentToOrderOutcome', () => {
  it('drives a paid order from a succeeded payment', () => {
    expect(mapPaymentToOrderOutcome(PaymentStatus.SUCCEEDED)).toBe('PAID');
  });

  it('drives a failed order from a failed payment', () => {
    expect(mapPaymentToOrderOutcome(PaymentStatus.FAILED)).toBe('FAILED');
  });

  it('returns null for non-terminal or non-webhook statuses (nothing to finalize)', () => {
    expect(mapPaymentToOrderOutcome(PaymentStatus.PENDING)).toBeNull();
    expect(mapPaymentToOrderOutcome(PaymentStatus.EXPIRED)).toBeNull();
  });
});
