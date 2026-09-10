import type { PinoLogger } from 'nestjs-pino';
import { describe, expect, it, vi } from 'vitest';
import type { DrizzleTx } from '@shared/infrastructure/database';
import type { MetricsPort } from '@shared/observability/metrics/metrics.port';
import { PaymentStatus } from '../../domain/payment-status';
import { Payment } from '../../domain/payment.entity';
import type { PaymentGatewayPort } from '../ports/payment-gateway.port';
import type { PaymentRepositoryPort } from '../ports/payment-repository.port';
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

function build(found: Payment | null = payment()) {
  const findByOrderId = vi.fn().mockResolvedValue(found);
  const updateStatus = vi.fn().mockResolvedValue(payment(PaymentStatus.EXPIRED));
  const expireSession = vi.fn().mockResolvedValue('expired');
  const recordRefundOwed = vi.fn();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  const useCase = new ExpirePaymentSessionUseCase(
    { findByOrderId, updateStatus } as unknown as PaymentRepositoryPort,
    { expireSession } as unknown as PaymentGatewayPort,
    { recordRefundOwed } as unknown as MetricsPort,
    logger as unknown as PinoLogger,
  );
  return { useCase, findByOrderId, updateStatus, expireSession, recordRefundOwed, logger };
}

describe('ExpirePaymentSessionUseCase', () => {
  it('closes the session at the gateway, then marks the payment EXPIRED under the consumer tx', async () => {
    const { useCase, updateStatus, expireSession } = build();

    expect(await useCase.execute(ORDER_ID, TX)).toBe('expired');

    expect(expireSession).toHaveBeenCalledWith(SESSION);
    // Compare-and-set, and on the caller's transaction so it commits with the inbox claim.
    expect(updateStatus).toHaveBeenCalledWith(PAYMENT_ID, PaymentStatus.EXPIRED, {
      tx: TX,
      expectedStatus: PaymentStatus.PENDING,
    });
  });

  it('reads the payment on the consumer tx rather than taking a second connection', async () => {
    const { useCase, findByOrderId } = build();

    await useCase.execute(ORDER_ID, TX);

    expect(findByOrderId).toHaveBeenCalledWith(ORDER_ID, TX);
  });

  // The common case: the buyer never opened checkout, so the order timed out with no money side.
  it('does nothing and asks the gateway nothing when the order has no payment', async () => {
    const { useCase, expireSession, updateStatus } = build(null);

    expect(await useCase.execute(ORDER_ID, TX)).toBe('no_payment');
    expect(expireSession).not.toHaveBeenCalled();
    expect(updateStatus).not.toHaveBeenCalled();
  });

  it.each([PaymentStatus.FAILED, PaymentStatus.EXPIRED] as const)(
    'leaves an already-%s payment alone, without touching the gateway',
    async (status) => {
      const { useCase, expireSession, recordRefundOwed, logger } = build(payment(status));

      expect(await useCase.execute(ORDER_ID, TX)).toBe('already_settled');
      expect(expireSession).not.toHaveBeenCalled();
      expect(recordRefundOwed).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
    },
  );

  it('raises the refund decision when the order died on top of a payment that had succeeded', async () => {
    const { useCase, expireSession, recordRefundOwed, logger } = build(payment(PaymentStatus.SUCCEEDED));

    expect(await useCase.execute(ORDER_ID, TX)).toBe('refund_owed');
    // Nothing to expire — the session was consumed — and no retry recovers stock already resold.
    expect(expireSession).not.toHaveBeenCalled();
    expect(recordRefundOwed).toHaveBeenCalledExactlyOnceWith('expire_session');
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: ORDER_ID }),
      expect.stringContaining('already succeeded'),
    );
  });

  it('raises the refund decision, once, when the gateway reports the session already paid', async () => {
    const { useCase, expireSession, updateStatus, recordRefundOwed, logger } = build();
    expireSession.mockResolvedValue('already_completed');

    expect(await useCase.execute(ORDER_ID, TX)).toBe('refund_owed');

    // Acknowledged rather than retried: no redelivery un-pays a session. Writing EXPIRED here would
    // additionally record a settlement that never happened.
    expect(updateStatus).not.toHaveBeenCalled();
    expect(recordRefundOwed).toHaveBeenCalledExactlyOnceWith('expire_session');
    expect(logger.error).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ orderId: ORDER_ID }),
      expect.stringContaining('refund owed'),
    );
  });

  it('carries the trigger so the refund line says which path killed the order', async () => {
    const { useCase, expireSession, logger } = build();
    expireSession.mockResolvedValue('already_completed');

    await useCase.execute(ORDER_ID, TX, 'cancel');

    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ trigger: 'cancel' }), expect.any(String));
  });

  // The redelivery after a consume that expired the session and then rolled back. Nothing is owed
  // and nothing is wrong: it finishes the write the first attempt lost.
  it('finishes normally when the session was already closed by an earlier attempt', async () => {
    const { useCase, expireSession, updateStatus, recordRefundOwed } = build();
    expireSession.mockResolvedValue('already_closed');

    expect(await useCase.execute(ORDER_ID, TX)).toBe('expired');
    expect(updateStatus).toHaveBeenCalledOnce();
    expect(recordRefundOwed).not.toHaveBeenCalled();
  });

  // An unreachable gateway must take the whole consume down: the transaction rolls back with the
  // inbox claim and the queue redelivers.
  it('propagates a gateway failure without writing the payment', async () => {
    const { useCase, expireSession, updateStatus } = build();
    expireSession.mockRejectedValue(new Error('gateway could not expire a session'));

    await expect(useCase.execute(ORDER_ID, TX)).rejects.toThrow('gateway could not expire a session');
    expect(updateStatus).not.toHaveBeenCalled();
  });

  it('backs off when a webhook settles the payment inside the gateway round-trip', async () => {
    const { useCase, updateStatus, logger } = build();
    updateStatus.mockResolvedValue(null);

    expect(await useCase.execute(ORDER_ID, TX)).toBe('raced');
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: ORDER_ID }),
      expect.stringContaining('settled by a webhook'),
    );
  });
});
