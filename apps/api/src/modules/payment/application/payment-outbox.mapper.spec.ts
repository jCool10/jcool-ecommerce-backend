import { describe, expect, it } from 'vitest';
import { PaymentStatus } from '../domain/payment-status';
import { toAuthorizedOutboxRecord, toSettledOutboxRecord } from './payment-outbox.mapper';

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
  });
});

describe('toSettledOutboxRecord', () => {
  it('carries the order and the gateway handle, with timestamps as strings', () => {
    const record = toSettledOutboxRecord({
      paymentId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      orderId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      paymentRef: 'pi_live_1',
      settledAt: new Date('2026-08-26T10:00:00.000Z'),
      status: PaymentStatus.SUCCEEDED,
    });

    expect(record.payload).toEqual({
      paymentId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      orderId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      paymentRef: 'pi_live_1',
      settledAt: '2026-08-26T10:00:00.000Z',
    });
  });
});
