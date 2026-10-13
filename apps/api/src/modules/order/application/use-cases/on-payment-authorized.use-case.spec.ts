import { describe, expect, it, vi } from 'vitest';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { Order } from '../../domain/order.entity';
import { OrderItem } from '../../domain/order-item.entity';
import { OrderStatus } from '../../domain/order-status';
import type { CheckoutSagaEnginePort } from '../ports/checkout-saga-engine.port';
import type { OrderRepositoryPort } from '../ports/order-repository.port';
import { OnPaymentAuthorizedUseCase, type PaymentAuthorized } from './on-payment-authorized.use-case';

const ORDER_ID = '900001';
const AUTHORIZED: PaymentAuthorized = {
  paymentId: '800001',
  orderId: ORDER_ID,
  amountMinor: 240_000,
  currency: 'VND',
  authorizedAt: new Date('2026-03-01T09:30:00.000Z'),
};

const order = Order.rehydrate({
  id: ORDER_ID,
  userId: 'u1',
  status: OrderStatus.PENDING,
  currency: 'VND',
  items: [OrderItem.of('sku-1', 'Widget', 120_000, 2)],
  totalAmountMinor: 240_000,
  placedAt: new Date('2026-03-01T09:00:00.000Z'),
  paymentDeadlineAt: new Date('2026-03-01T10:00:00.000Z'),
});

function build(found: Order | null = order) {
  const orders = { findById: vi.fn<OrderRepositoryPort['findById']>(() => Promise.resolve(found)) };
  const engine = { notifyAuthorized: vi.fn<CheckoutSagaEnginePort['notifyAuthorized']>(() => Promise.resolve()) };
  const logError = vi.fn();
  const useCase = new OnPaymentAuthorizedUseCase(
    orders as unknown as OrderRepositoryPort,
    engine as unknown as CheckoutSagaEnginePort,
    fakePinoLogger({ error: logError }),
  );
  return { useCase, engine, logError };
}

describe('OnPaymentAuthorizedUseCase', () => {
  it('hands the authorization to the saga as it came, leaving the amount check to the saga', async () => {
    const { useCase, engine } = build();

    await useCase.execute({ ...AUTHORIZED, amountMinor: 1 });

    expect(engine.notifyAuthorized).toHaveBeenCalledExactlyOnceWith(ORDER_ID, {
      paymentId: '800001',
      amountMinor: 1,
      currency: 'VND',
      authorizedAt: AUTHORIZED.authorizedAt,
    });
  });

  it('acknowledges an authorization for an order that does not exist, logging it for a refund', async () => {
    const { useCase, engine, logError } = build(null);

    await expect(useCase.execute(AUTHORIZED)).resolves.toBeUndefined();

    expect(engine.notifyAuthorized).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledWith({ orderId: ORDER_ID, paymentId: '800001' }, expect.any(String));
  });

  it('fails when the saga cannot be reached, so the message is redelivered', async () => {
    const { useCase, engine } = build();
    const outage = new Error('temporal unavailable');
    engine.notifyAuthorized.mockRejectedValueOnce(outage);

    await expect(useCase.execute(AUTHORIZED)).rejects.toBe(outage);
  });
});
