import { describe, expect, it, vi } from 'vitest';
import type { DrizzleTx } from '@shared/infrastructure/database';
import { fakeMetricsPort } from '@jcool/testing/fake-metrics-port';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { PaymentStatus } from '../../domain/payment-status';
import { Payment } from '../../domain/payment.entity';
import type { ExpireSessionOutcome } from '../ports/payment-gateway.port';
import { fakePaymentGateway, fakePaymentRepository } from '../../testing/payment-port.doubles';
import { ExpirePaymentSessionUseCase } from './expire-payment-session.use-case';

const ORDER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PAYMENT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SESSION = 'cs_test_expiring';
const TX = {} as DrizzleTx;

function payment(status: PaymentStatus = PaymentStatus.PENDING): Payment {
  return Payment.rehydrate({
    id: PAYMENT_ID,
    orderId: ORDER_ID,
    provider: 'stripe',
    providerSessionId: SESSION,
    providerIntentId: null,
    amountMinor: 200_000,
    currency: 'VND',
    status,
  });
}

function build(found: Payment | null, gatewayAnswer: ExpireSessionOutcome = 'expired', casWins = true) {
  const updateStatus = vi.fn().mockResolvedValue(casWins ? payment(PaymentStatus.EXPIRED) : null);
  const expireSession = vi.fn().mockResolvedValue(gatewayAnswer);
  const metrics = fakeMetricsPort();
  const error = vi.fn();
  const useCase = new ExpirePaymentSessionUseCase(
    fakePaymentRepository({ findByOrderId: vi.fn().mockResolvedValue(found), updateStatus }),
    fakePaymentGateway({ expireSession }),
    metrics,
    fakePinoLogger({ error }),
  );
  return { useCase, updateStatus, expireSession, metrics, error };
}

describe('ExpirePaymentSessionUseCase', () => {
  it('closes a pending session and expires its payment, backing off from anything already settled', async () => {
    // Compare-and-set, on the consumer's transaction so it commits with the inbox claim.
    const WRITE = [PAYMENT_ID, PaymentStatus.EXPIRED, { tx: TX, expectedStatus: PaymentStatus.PENDING }];
    const cases: Array<[string, Parameters<typeof build>]> = [
      ['no payment', [null]],
      ['already failed', [payment(PaymentStatus.FAILED)]],
      ['already expired', [payment(PaymentStatus.EXPIRED)]],
      ['closed now', [payment(), 'expired']],
      ['closed by an earlier attempt', [payment(), 'already_closed']],
      ['paid at the gateway', [payment(), 'already_completed']],
      ['settled by a webhook meanwhile', [payment(), 'expired', false]],
    ];

    const outcomes = await Promise.all(
      cases.map(async ([label, args]) => {
        const { useCase, updateStatus, expireSession, metrics } = build(...args);
        const result = await useCase.execute(ORDER_ID, TX);
        return [
          label,
          result,
          expireSession.mock.calls.length,
          updateStatus.mock.calls,
          metrics.recordRefundOwed.mock.calls,
        ];
      }),
    );

    expect(outcomes).toEqual([
      ['no payment', 'no_payment', 0, [], []],
      ['already failed', 'already_settled', 0, [], []],
      ['already expired', 'already_settled', 0, [], []],
      ['closed now', 'expired', 1, [WRITE], []],
      ['closed by an earlier attempt', 'expired', 1, [WRITE], []],
      // Writing EXPIRED here would record a settlement that never happened.
      ['paid at the gateway', 'refund_owed', 1, [], [['expire_session']]],
      ['settled by a webhook meanwhile', 'raced', 1, [WRITE], []],
    ]);
  });

  it('raises the refund decision when the order died on top of a payment that had succeeded', async () => {
    const { useCase, expireSession, metrics, error } = build(payment(PaymentStatus.SUCCEEDED));

    expect(await useCase.execute(ORDER_ID, TX, 'cancel')).toBe('refund_owed');
    expect(expireSession).not.toHaveBeenCalled();
    expect(metrics.recordRefundOwed).toHaveBeenCalledExactlyOnceWith('expire_session');
    // Fields, not message text: every refund-owed line groups under one message and stays filterable.
    expect(error).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ orderId: ORDER_ID, trigger: 'cancel', because: 'payment_already_succeeded' }),
      expect.any(String),
    );
  });
});
