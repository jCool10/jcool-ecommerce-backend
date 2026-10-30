import { describe, expect, it } from 'vitest';
import { isPaymentAuthorizedPayload } from '@jcool/internal-contracts/events/payment-authorized';
import { toAuthorizedOutboxRecord } from './payment-outbox.mapper';

describe('toAuthorizedOutboxRecord', () => {
  it('publishes the hold on the payment aggregate, with the exact instant the header recorded', () => {
    const record = toAuthorizedOutboxRecord({
      paymentId: '9001',
      orderId: '7001',
      amountMinor: 150_000,
      currency: 'VND',
      authorizedAt: new Date('2026-10-20T10:00:00.123Z'),
    });

    expect(record).toEqual({
      aggregateType: 'Payment',
      aggregateId: '9001',
      eventType: 'payment.authorized',
      payload: {
        paymentId: '9001',
        orderId: '7001',
        amountMinor: 150_000,
        currency: 'VND',
        authorizedAt: '2026-10-20T10:00:00.123Z',
      },
    });
    expect(isPaymentAuthorizedPayload(record.payload)).toBe(true);
  });
});
