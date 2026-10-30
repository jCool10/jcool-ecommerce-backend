import { describe, expect, it, vi } from 'vitest';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import type { PaymentAuthorization } from '../../domain/checkout-saga';
import { Order } from '../../domain/order.entity';
import { OrderItem } from '../../domain/order-item.entity';
import { OrderStatus } from '../../domain/order-status';
import { CheckoutEngineUnavailableError, type CheckoutSagaEnginePort } from '../ports/checkout-saga-engine.port';
import type { OrderRepositoryPort } from '../ports/order-repository.port';
import { ForwardPaymentAuthorizationUseCase } from './forward-payment-authorization.use-case';

const PLACED_AT = new Date('2026-10-20T08:00:00.000Z');
const DEADLINE = new Date('2026-10-20T09:00:00.000Z');
const AUTHORIZATION: PaymentAuthorization = {
  paymentId: 'pay-1',
  amountMinor: 200_000,
  currency: 'VND',
  authorizedAt: '2026-10-20T08:10:00.000Z',
};

function order(paymentDeadlineAt: Date | null = DEADLINE): Order {
  return Order.rehydrate({
    id: 'order-1',
    userId: 'u1',
    status: OrderStatus.EXPIRED,
    currency: 'VND',
    items: [OrderItem.of('sku-1', 'Widget', 100_000, 2)],
    totalAmountMinor: 200_000,
    placedAt: PLACED_AT,
    paymentDeadlineAt,
  });
}

function build(found: Order | null, engineError?: Error) {
  const notifyAuthorized = vi.fn(() => (engineError ? Promise.reject(engineError) : Promise.resolve()));
  const logger = { warn: vi.fn(), error: vi.fn() };
  const useCase = new ForwardPaymentAuthorizationUseCase(
    { findById: vi.fn().mockResolvedValue(found) } as unknown as OrderRepositoryPort,
    { notifyAuthorized } as unknown as CheckoutSagaEnginePort,
    fakePinoLogger(logger),
  );
  return { useCase, notifyAuthorized, logger };
}

describe('ForwardPaymentAuthorizationUseCase', () => {
  // The run checks the authorization against payment itself; this only gets it there.
  it("hands the authorization to the order's saga, starting a late run should the saga have closed", async () => {
    const { useCase, notifyAuthorized } = build(order());

    await useCase.execute('order-1', AUTHORIZATION);

    expect(notifyAuthorized).toHaveBeenCalledExactlyOnceWith(
      {
        mode: 'lateAuthorization',
        orderId: 'order-1',
        userId: 'u1',
        lines: [{ skuId: 'sku-1', quantity: 2 }],
        totalMinor: 200_000,
        currency: 'VND',
        placedAt: PLACED_AT,
        deadlineAt: DEADLINE,
      },
      AUTHORIZATION,
    );
  });

  it('acks an authorization for an order that does not exist', async () => {
    const { useCase, notifyAuthorized, logger } = build(null);

    await useCase.execute('order-1', AUTHORIZATION);

    expect(notifyAuthorized).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('acks, loudly, an authorization for an order no saga ever placed', async () => {
    const { useCase, notifyAuthorized, logger } = build(order(null));

    await useCase.execute('order-1', AUTHORIZATION);

    expect(notifyAuthorized).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledOnce();
  });

  it('throws an engine fault so the job retries', async () => {
    const down = new CheckoutEngineUnavailableError();
    const { useCase } = build(order(), down);

    await expect(useCase.execute('order-1', AUTHORIZATION)).rejects.toBe(down);
  });
});
