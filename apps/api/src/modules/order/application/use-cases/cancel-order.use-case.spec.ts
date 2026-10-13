import { ConflictException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { Order } from '../../domain/order.entity';
import { OrderItem } from '../../domain/order-item.entity';
import { OrderStatus } from '../../domain/order-status';
import { checkoutSagaSettings } from '../../testing/checkout-saga-settings.double';
import { CheckoutUnavailableException } from '../checkout-unavailable.exception';
import {
  CheckoutEngineUnavailableError,
  CheckoutNotCancellableError,
  type CheckoutSagaEnginePort,
} from '../ports/checkout-saga-engine.port';
import type { OrderRepositoryPort } from '../ports/order-repository.port';
import { CancelOrderUseCase } from './cancel-order.use-case';

const ORDER_ID = '900001';
const OWNER = 'u-owner';
const STRANGER = 'u-stranger';
const settings = checkoutSagaSettings({ cancelWaitMs: 10_000 });

const orderIn = (status: OrderStatus, reason: string | null = null): Order =>
  Order.rehydrate({
    id: ORDER_ID,
    userId: OWNER,
    status,
    currency: 'VND',
    items: [OrderItem.of('sku-1', 'Widget', 100_000, 1)],
    totalAmountMinor: 100_000,
    placedAt: new Date('2026-03-01T09:00:00.000Z'),
    paymentDeadlineAt: new Date('2026-03-01T10:00:00.000Z'),
    finalizedAt: reason ? new Date('2026-03-01T09:10:00.000Z') : null,
    finalizeReason: reason,
  });

/** `rows` are what each successive read of the order returns. */
function build(...rows: (Order | null)[]) {
  const orders = { findById: vi.fn<OrderRepositoryPort['findById']>() };
  for (const row of rows) orders.findById.mockResolvedValueOnce(row);
  const engine = { cancel: vi.fn<CheckoutSagaEnginePort['cancel']>(() => Promise.resolve('accepted')) };
  const useCase = new CancelOrderUseCase(
    orders as unknown as OrderRepositoryPort,
    engine as unknown as CheckoutSagaEnginePort,
    settings,
    fakePinoLogger(),
  );
  return { useCase, orders, engine };
}

describe('CancelOrderUseCase', () => {
  it.each([
    ['a stranger', orderIn(OrderStatus.PENDING), STRANGER],
    ['the owner of a reserving order', orderIn(OrderStatus.RESERVING), OWNER],
    ['the owner of a rejected order', orderIn(OrderStatus.REJECTED), OWNER],
    ['anyone, for an order that does not exist', null, OWNER],
  ])('answers 404 to %s without asking the saga', async (_label, row, userId) => {
    const { useCase, engine } = build(row);

    await expect(useCase.cancelOwn(ORDER_ID, userId)).rejects.toBeInstanceOf(NotFoundException);
    expect(engine.cancel).not.toHaveBeenCalled();
  });

  it.each([OrderStatus.CONFIRMING, OrderStatus.PAID, OrderStatus.EXPIRED, OrderStatus.FAILED])(
    'answers 409 for an order already %s without asking the saga',
    async (status) => {
      const { useCase, engine } = build(orderIn(status));

      await expect(useCase.cancelOwn(ORDER_ID, OWNER)).rejects.toBeInstanceOf(ConflictException);
      expect(engine.cancel).not.toHaveBeenCalled();
    },
  );

  it('answers a repeat cancel with the cancelled order, without asking the saga', async () => {
    const { useCase, engine } = build(orderIn(OrderStatus.CANCELLED, 'user:cancel'));

    await expect(useCase.cancelOwn(ORDER_ID, OWNER)).resolves.toMatchObject({ status: OrderStatus.CANCELLED });
    expect(engine.cancel).not.toHaveBeenCalled();
  });

  it.each([
    ['buyer', 'user', 'user:cancel'],
    ['admin', 'admin', 'admin:cancel'],
  ] as const)('cancels for the %s through the saga, then answers the row it wrote', async (_label, by, reason) => {
    const { useCase, orders, engine } = build(orderIn(OrderStatus.PENDING), orderIn(OrderStatus.CANCELLED, reason));

    const view = by === 'user' ? await useCase.cancelOwn(ORDER_ID, OWNER) : await useCase.cancelAsAdmin(ORDER_ID);

    expect(engine.cancel).toHaveBeenCalledExactlyOnceWith(ORDER_ID, by);
    expect(orders.findById).toHaveBeenCalledTimes(2);
    expect(view).toMatchObject({ id: ORDER_ID, status: OrderStatus.CANCELLED });
  });

  // The row can still read PENDING while the saga already holds an authorization.
  it('answers 409 when the saga refuses, because the money is already moving', async () => {
    const { useCase, engine } = build(orderIn(OrderStatus.PENDING), orderIn(OrderStatus.CONFIRMING));
    engine.cancel.mockRejectedValueOnce(new CheckoutNotCancellableError(ORDER_ID));

    await expect(useCase.cancelOwn(ORDER_ID, OWNER)).rejects.toBeInstanceOf(ConflictException);
  });

  it('answers 200 when the saga refuses only because a concurrent cancel won', async () => {
    const { useCase, engine } = build(orderIn(OrderStatus.PENDING), orderIn(OrderStatus.CANCELLED, 'admin:cancel'));
    engine.cancel.mockRejectedValueOnce(new CheckoutNotCancellableError(ORDER_ID));

    await expect(useCase.cancelOwn(ORDER_ID, OWNER)).resolves.toMatchObject({ status: OrderStatus.CANCELLED });
  });

  it.each([
    ['expired', orderIn(OrderStatus.EXPIRED, 'deadline'), ConflictException],
    ['cancelled', orderIn(OrderStatus.CANCELLED, 'user:cancel'), undefined],
  ] as const)('answers from the row once the saga has closed and the order is %s', async (_label, row, rejection) => {
    const { useCase, engine } = build(orderIn(OrderStatus.PENDING), row);
    engine.cancel.mockResolvedValueOnce('closed');

    const outcome = useCase.cancelOwn(ORDER_ID, OWNER);

    if (rejection) await expect(outcome).rejects.toBeInstanceOf(rejection);
    else await expect(outcome).resolves.toMatchObject({ status: OrderStatus.CANCELLED });
  });

  it('answers 503 with Retry-After when the saga cannot be reached', async () => {
    const { useCase, engine } = build(orderIn(OrderStatus.PENDING));
    engine.cancel.mockRejectedValueOnce(new CheckoutEngineUnavailableError('cancel'));

    const error = await useCase.cancelOwn(ORDER_ID, OWNER).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CheckoutUnavailableException);
    expect((error as CheckoutUnavailableException).retryAfterSec).toBe(10);
  });
});
