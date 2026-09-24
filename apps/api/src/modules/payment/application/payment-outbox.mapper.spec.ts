import { describe, expect, it } from 'vitest';
import { PaymentStatus } from '../domain/payment-status';
import { toSettledOutboxRecord } from './payment-outbox.mapper';

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
