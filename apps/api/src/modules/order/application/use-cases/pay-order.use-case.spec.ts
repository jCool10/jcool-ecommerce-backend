import { BadGatewayException, ConflictException, NotFoundException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeMetricsPort } from '@jcool/testing/fake-metrics-port';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { CheckoutSagaStep } from '../../domain/checkout-saga-step';
import { Order } from '../../domain/order.entity';
import { OrderItem } from '../../domain/order-item.entity';
import { OrderStatus } from '../../domain/order-status';
import type { CheckoutSaga, CheckoutSagaRepositoryPort } from '../ports/checkout-saga-repository.port';
import type { OrderRepositoryPort } from '../ports/order-repository.port';
import {
  PaymentUnavailableError,
  type OpenSessionAnswer,
  type PaymentTccPort,
} from '../ports/payment-participant.port';
import type { CheckoutSagaSettings } from '../saga/checkout-saga.settings';
import { PayOrderUseCase } from './pay-order.use-case';

const ORDER_ID = '900001';
const DEADLINE = new Date('2026-03-01T10:00:00.000Z');
const CUTOFF_MS = 1_980_000;
const settings = { payCutoffMs: CUTOFF_MS } as CheckoutSagaSettings;
const SESSION = { paymentId: '800001', providerSessionId: 'cs_test_1', redirectUrl: 'https://pay.test/cs_test_1' };

const orderIn = (status: OrderStatus): Order =>
  Order.rehydrate({
    id: ORDER_ID,
    userId: 'u1',
    status,
    currency: 'VND',
    items: [OrderItem.of('sku-1', 'Widget', 120_000, 2)],
    totalAmountMinor: 240_000,
    placedAt: new Date('2026-03-01T09:00:00.000Z'),
  });

const saga: CheckoutSaga = {
  orderId: ORDER_ID,
  step: CheckoutSagaStep.AWAITING_AUTH,
  pendingCompensations: [],
  deadlineAt: DEADLINE,
  nextAttemptAt: DEADLINE,
  attempts: 0,
  leaseUntil: null,
  lastError: null,
  version: 3,
};

function build(order: Order | null = orderIn(OrderStatus.PENDING)) {
  const orders = { findForUser: vi.fn().mockResolvedValue(order) };
  const sagas = { findByOrderId: vi.fn().mockResolvedValue(saga) };
  const payment = {
    openSession: vi.fn((): Promise<OpenSessionAnswer> => Promise.resolve({ outcome: 'OPENED', session: SESSION })),
  };
  const metrics = fakeMetricsPort();
  const useCase = new PayOrderUseCase(
    orders as unknown as OrderRepositoryPort,
    sagas as unknown as CheckoutSagaRepositoryPort,
    payment as unknown as PaymentTccPort,
    settings,
    metrics,
    fakePinoLogger(),
  );
  return { useCase, orders, payment, metrics };
}

describe('PayOrderUseCase', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(DEADLINE.getTime() - CUTOFF_MS - 1);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens a session for the order's own total that expires exactly at the payment deadline", async () => {
    const { useCase, orders, payment, metrics } = build();

    await expect(useCase.execute(ORDER_ID, 'u1')).resolves.toEqual(SESSION);

    expect(orders.findForUser).toHaveBeenCalledWith(ORDER_ID, 'u1');
    expect(payment.openSession).toHaveBeenCalledWith({
      orderId: ORDER_ID,
      amountMinor: 240_000,
      currency: 'VND',
      expiresAt: DEADLINE,
    });
    expect(metrics.recordSagaStep).toHaveBeenCalledExactlyOnceWith('open_session', 'success');
  });

  it("answers 404 to an order the caller cannot see, someone else's or one still reserving", async () => {
    const { useCase, payment } = build(null);

    await expect(useCase.execute(ORDER_ID, 'u2')).rejects.toBeInstanceOf(NotFoundException);
    expect(payment.openSession).not.toHaveBeenCalled();
  });

  it.each([OrderStatus.CONFIRMING, OrderStatus.PAID, OrderStatus.CANCELLED, OrderStatus.EXPIRED])(
    'answers 409 to an order in %s',
    async (status) => {
      const { useCase, payment } = build(orderIn(status));

      await expect(useCase.execute(ORDER_ID, 'u1')).rejects.toBeInstanceOf(ConflictException);
      expect(payment.openSession).not.toHaveBeenCalled();
    },
  );

  it('answers 409 from the pay cutoff on, without asking the gateway', async () => {
    vi.setSystemTime(DEADLINE.getTime() - CUTOFF_MS);
    const { useCase, payment } = build();

    const error = await useCase.execute(ORDER_ID, 'u1').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).message).toBe('Payment window closed');
    expect(payment.openSession).not.toHaveBeenCalled();
  });

  it('answers 409 when the participant will not open a session', async () => {
    const { useCase, payment, metrics } = build();
    payment.openSession.mockResolvedValueOnce({ outcome: 'CLOSED' });

    const error = await useCase.execute(ORDER_ID, 'u1').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).message).toBe('Payment window closed');
    expect(metrics.recordSagaStep).toHaveBeenCalledExactlyOnceWith('open_session', 'failed');
  });

  it('answers 502 when the payment provider cannot be reached', async () => {
    const { useCase, payment, metrics } = build();
    payment.openSession.mockRejectedValueOnce(new PaymentUnavailableError());

    const error = await useCase.execute(ORDER_ID, 'u1').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BadGatewayException);
    expect((error as BadGatewayException).message).toBe('Payment provider is temporarily unavailable');
    expect(metrics.recordSagaStep).toHaveBeenCalledExactlyOnceWith('open_session', 'failed');
  });
});
