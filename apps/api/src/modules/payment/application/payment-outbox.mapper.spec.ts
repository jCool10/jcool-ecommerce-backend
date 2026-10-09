import { describe, expect, it } from 'vitest';
import { toAuthorizedOutboxRecord } from './payment-outbox.mapper';

describe('toAuthorizedOutboxRecord', () => {
  // The order side checks the held amount against its own total, so the money rides in the event.
  it('carries the hold and when it was recorded', () => {
    const record = toAuthorizedOutboxRecord({
      paymentId: '7400000000000000001',
      orderId: '7400000000000000002',
      amountMinor: 150_000,
      currency: 'VND',
      authorizedAt: new Date('2026-10-06T10:00:00.000Z'),
    });

    expect(record).toEqual({
      aggregateType: 'Payment',
      aggregateId: '7400000000000000001',
      eventType: 'payment.authorized',
      payload: {
        paymentId: '7400000000000000001',
        orderId: '7400000000000000002',
        amountMinor: 150_000,
        currency: 'VND',
        authorizedAt: '2026-10-06T10:00:00.000Z',
      },
    });
  });
});
