import { describe, expect, it } from 'vitest';
import { PaymentStatus } from '../domain/payment-status';
import { toSettledOutboxRecord } from './payment-outbox.mapper';

const FACTS = {
  paymentId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  orderId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  paymentRef: 'pi_live_1',
  settledAt: new Date('2026-08-26T10:00:00.000Z'),
};

describe('toSettledOutboxRecord', () => {
  it.each([
    [PaymentStatus.SUCCEEDED, 'payment.succeeded'],
    [PaymentStatus.FAILED, 'payment.failed'],
  ] as const)('names %s as %s', (status, eventType) => {
    expect(toSettledOutboxRecord({ ...FACTS, status })).toMatchObject({ eventType, aggregateId: FACTS.paymentId });
  });

  // The consumer settles an ORDER from an event about a PAYMENT, so the link has to travel in the
  // payload — re-reading Payment's tables from Order is exactly what the published event replaces.
  it('carries the order and the gateway handle, with timestamps as strings', () => {
    const record = toSettledOutboxRecord({ ...FACTS, status: PaymentStatus.SUCCEEDED });

    expect(record.payload).toEqual({
      paymentId: FACTS.paymentId,
      orderId: FACTS.orderId,
      paymentRef: 'pi_live_1',
      settledAt: '2026-08-26T10:00:00.000Z',
    });
  });

  it('keeps a missing gateway handle as null rather than dropping the field', () => {
    const record = toSettledOutboxRecord({ ...FACTS, status: PaymentStatus.FAILED, paymentRef: null });

    expect(record.payload).toMatchObject({ paymentRef: null });
  });
});
