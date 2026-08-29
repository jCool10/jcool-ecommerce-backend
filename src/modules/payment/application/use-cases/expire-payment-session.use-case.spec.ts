import type { PinoLogger } from 'nestjs-pino';
import { describe, expect, it, vi } from 'vitest';
import type { DrizzleTx } from '@shared/infrastructure/database';
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
  const expireSession = vi.fn().mockResolvedValue(undefined);
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  const useCase = new ExpirePaymentSessionUseCase(
    { findByOrderId, updateStatus } as unknown as PaymentRepositoryPort,
    { expireSession } as unknown as PaymentGatewayPort,
    logger as unknown as PinoLogger,
  );
  return { useCase, findByOrderId, updateStatus, expireSession, logger };
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
      const { useCase, expireSession, logger } = build(payment(status));

      expect(await useCase.execute(ORDER_ID, TX)).toBe('already_settled');
      expect(expireSession).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
    },
  );

  it('raises the refund decision when the order expired on top of a payment that had succeeded', async () => {
    const { useCase, expireSession, logger } = build(payment(PaymentStatus.SUCCEEDED));

    expect(await useCase.execute(ORDER_ID, TX)).toBe('already_settled');
    // Nothing to expire — the session was consumed — and no retry recovers stock already resold.
    expect(expireSession).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: ORDER_ID }),
      expect.stringContaining('already succeeded'),
    );
  });

  // A gateway that refuses (including because the session was just paid) must take the whole
  // consume down: the transaction rolls back with the inbox claim and the queue redelivers.
  it('propagates a gateway refusal without writing the payment', async () => {
    const { useCase, expireSession, updateStatus } = build();
    expireSession.mockRejectedValue(new Error('session already completed'));

    await expect(useCase.execute(ORDER_ID, TX)).rejects.toThrow('session already completed');
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
