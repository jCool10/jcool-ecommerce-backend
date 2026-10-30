import { ConflictException, HttpException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { Order } from '../../domain/order.entity';
import { OrderStatus } from '../../domain/order-status';
import { CheckoutUnavailableError } from '../checkout-unavailable.error';
import {
  CheckoutCancelRejectedError,
  CheckoutEngineUnavailableError,
  CheckoutSagaClosedError,
  type CheckoutSagaEnginePort,
} from '../ports/checkout-saga-engine.port';
import type { OrderRepositoryPort } from '../ports/order-repository.port';
import { CancelOrderUseCase } from './cancel-order.use-case';

const ORDER_ID = 'order-1';
const OWNER = 'u1';

function order(status: OrderStatus, finalizeReason: string | null = null): Order {
  return Order.rehydrate({
    id: ORDER_ID,
    userId: OWNER,
    status,
    currency: 'VND',
    items: [],
    totalAmountMinor: 100_000,
    placedAt: new Date('2026-10-20T08:00:00Z'),
    finalizeReason,
  });
}

const CANCELLED = order(OrderStatus.CANCELLED, 'user:cancel');

/** `found` is what a read sees before the engine call, `reread` what it sees after. */
function build(found: Order | null, opts: { engine?: Error; reread?: Order } = {}) {
  const cancel = vi.fn(() => (opts.engine ? Promise.reject(opts.engine) : Promise.resolve()));
  const findForUser = vi.fn().mockResolvedValue(found);
  const findById = vi.fn(() => Promise.resolve(cancel.mock.calls.length > 0 ? (opts.reread ?? CANCELLED) : found));
  const useCase = new CancelOrderUseCase(
    { findForUser, findById } as unknown as OrderRepositoryPort,
    { cancel } as unknown as CheckoutSagaEnginePort,
    fakePinoLogger(),
  );
  return { useCase, cancel, findForUser };
}

const statusOf = (promise: Promise<unknown>) =>
  promise.then(
    () => 200,
    (error: unknown) => {
      if (error instanceof HttpException) return error.getStatus();
      if (error instanceof CheckoutUnavailableError) return 503;
      throw error;
    },
  );

describe('CancelOrderUseCase', () => {
  it('cancels through the saga and answers the order as it now reads', async () => {
    const { useCase, cancel } = build(order(OrderStatus.PENDING));

    const view = await useCase.cancelOwn(ORDER_ID, OWNER);

    expect(cancel).toHaveBeenCalledExactlyOnceWith(ORDER_ID, 'buyer');
    expect(view).toMatchObject({ id: ORDER_ID, status: OrderStatus.CANCELLED, finalizeReason: 'user:cancel' });
  });

  it('tells the saga an admin cancelled', async () => {
    const { useCase, cancel, findForUser } = build(order(OrderStatus.PENDING));

    await useCase.cancelAsAdmin(ORDER_ID);

    expect(cancel).toHaveBeenCalledExactlyOnceWith(ORDER_ID, 'admin');
    expect(findForUser).not.toHaveBeenCalled();
  });

  it('answers 404 for an order the buyer cannot see, before the saga hears of it', async () => {
    const { useCase, cancel } = build(null);

    await expect(useCase.cancelOwn(ORDER_ID, OWNER)).rejects.toThrow(
      new NotFoundException(`Order not found: ${ORDER_ID}`),
    );
    await expect(useCase.cancelAsAdmin(ORDER_ID)).rejects.toThrow(NotFoundException);
    expect(cancel).not.toHaveBeenCalled();
  });

  it('answers a cancelled order again without asking the saga', async () => {
    const { useCase, cancel } = build(CANCELLED);

    expect(await useCase.cancelOwn(ORDER_ID, OWNER)).toMatchObject({ status: OrderStatus.CANCELLED });
    expect(cancel).not.toHaveBeenCalled();
  });

  it('answers 409 for an order past PENDING', async () => {
    for (const status of [OrderStatus.CONFIRMING, OrderStatus.PAID, OrderStatus.FAILED, OrderStatus.EXPIRED]) {
      const { useCase, cancel } = build(order(status));

      await expect(useCase.cancelAsAdmin(ORDER_ID)).rejects.toThrow(
        new ConflictException(`Order cannot be cancelled in status ${status}`),
      );
      expect(cancel).not.toHaveBeenCalled();
    }
  });

  it('answers 409 when the saga is already taking the payment', async () => {
    const { useCase } = build(order(OrderStatus.PENDING), {
      engine: new CheckoutCancelRejectedError(ORDER_ID, 'COMMITTING_STOCK'),
    });

    expect(await statusOf(useCase.cancelOwn(ORDER_ID, OWNER))).toBe(409);
  });

  it('answers a closed saga from the order it left behind', async () => {
    const closed = new CheckoutSagaClosedError(ORDER_ID);

    const cancelled = build(order(OrderStatus.PENDING), { engine: closed, reread: CANCELLED });
    const expired = build(order(OrderStatus.PENDING), { engine: closed, reread: order(OrderStatus.EXPIRED) });

    expect(await statusOf(cancelled.useCase.cancelOwn(ORDER_ID, OWNER))).toBe(200);
    await expect(expired.useCase.cancelOwn(ORDER_ID, OWNER)).rejects.toThrow(
      new ConflictException('Order cannot be cancelled in status EXPIRED'),
    );
  });

  it('answers 200 once the cancel is recorded even if the compensations are still running, 503 before', async () => {
    const unavailable = new CheckoutEngineUnavailableError();

    const recorded = build(order(OrderStatus.PENDING), { engine: unavailable, reread: CANCELLED });
    const pending = build(order(OrderStatus.PENDING), { engine: unavailable, reread: order(OrderStatus.PENDING) });

    expect(await statusOf(recorded.useCase.cancelOwn(ORDER_ID, OWNER))).toBe(200);
    expect(await statusOf(pending.useCase.cancelOwn(ORDER_ID, OWNER))).toBe(503);
  });

  it('lets an unexpected engine fault through', async () => {
    const boom = new Error('boom');
    const { useCase } = build(order(OrderStatus.PENDING), { engine: boom });

    await expect(useCase.cancelOwn(ORDER_ID, OWNER)).rejects.toBe(boom);
  });
});
