import { ConflictException, HttpException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import type { DrizzleTx } from '@shared/infrastructure/database/drizzle.tokens';
import { CheckoutSagaStep, Compensation } from '../../domain/checkout-saga-step';
import type { SagaTransition } from '../../domain/checkout-saga';
import { Order } from '../../domain/order.entity';
import { OrderItem } from '../../domain/order-item.entity';
import { OrderStatus } from '../../domain/order-status';
import type { CheckoutSaga, CheckoutSagaRepositoryPort } from '../ports/checkout-saga-repository.port';
import type { OrderRepositoryPort } from '../ports/order-repository.port';
import type { CheckoutSagaWriter } from '../saga/checkout-saga.writer';
import type { AdvanceCheckoutSagaUseCase } from './advance-checkout-saga.use-case';
import { CancelOrderUseCase } from './cancel-order.use-case';

const ORDER_ID = '900001';
const OWNER = 'u-owner';
const STRANGER = 'u-stranger';
const EVENT_ID = '800001';
const TX = { tx: true } as unknown as DrizzleTx;

const orderIn = (status: OrderStatus): Order =>
  Order.rehydrate({
    id: ORDER_ID,
    userId: OWNER,
    status,
    currency: 'VND',
    items: [OrderItem.of('sku-1', 'Widget', 100_000, 1)],
    totalAmountMinor: 100_000,
    placedAt: new Date('2026-03-01T09:00:00.000Z'),
  });

const saga: CheckoutSaga = {
  orderId: ORDER_ID,
  step: CheckoutSagaStep.AWAITING_AUTH,
  pendingCompensations: [],
  deadlineAt: new Date('2026-03-01T10:00:00.000Z'),
  nextAttemptAt: new Date('2026-03-01T10:03:00.000Z'),
  attempts: 0,
  leaseUntil: null,
  lastError: null,
  version: 4,
};

function build(found: Order | null) {
  const log: string[] = [];
  const orders = {
    withTransaction: vi.fn(async <T>(fn: (tx: DrizzleTx) => Promise<T>) => {
      log.push('begin');
      const result = await fn(TX);
      log.push('commit');
      return result;
    }),
    findByIdForUpdate: vi.fn(() => {
      log.push('lock order');
      return Promise.resolve(found);
    }),
  };
  const sagas = {
    findForUpdate: vi.fn(() => {
      log.push('lock saga');
      return Promise.resolve(saga);
    }),
  };
  const writer = {
    rewrite: vi.fn((_tx: DrizzleTx, order: Order, _saga: CheckoutSaga, transition: SagaTransition) => {
      log.push('rewrite');
      const change = transition.order;
      return Promise.resolve(
        change && 'reason' in change && change.status === OrderStatus.CANCELLED
          ? order.settle(OrderStatus.CANCELLED, { now: new Date(), reason: change.reason })
          : order,
      );
    }),
    reportCommitted: vi.fn(() => log.push('report')),
  };
  const advance = {
    execute: vi.fn(() => {
      log.push('advance');
      return Promise.resolve();
    }),
  };
  const ids = {
    mint: vi.fn(() => {
      log.push('mint');
      return Promise.resolve([EVENT_ID]);
    }),
  };
  const logError = vi.fn();
  const useCase = new CancelOrderUseCase(
    orders as unknown as OrderRepositoryPort,
    sagas as unknown as CheckoutSagaRepositoryPort,
    writer as unknown as CheckoutSagaWriter,
    advance as unknown as AdvanceCheckoutSagaUseCase,
    ids,
    fakePinoLogger({ error: logError }),
  );
  const rewritten = () => writer.rewrite.mock.calls[0]?.[3];
  return { useCase, writer, advance, logError, log, rewritten };
}

const statusOf = (promise: Promise<unknown>) =>
  promise.then(
    () => 'resolved',
    (error: unknown) => (error instanceof HttpException ? error.getStatus() : error),
  );

describe('CancelOrderUseCase', () => {
  it('cancels under both row locks, then awaits the compensation before answering', async () => {
    const { useCase, writer, log, rewritten } = build(orderIn(OrderStatus.PENDING));

    const view = await useCase.cancelOwn(ORDER_ID, OWNER);

    expect(view).toMatchObject({ id: ORDER_ID, status: OrderStatus.CANCELLED });
    expect(log).toEqual(['mint', 'begin', 'lock order', 'lock saga', 'rewrite', 'commit', 'report', 'advance']);
    expect(writer.rewrite).toHaveBeenCalledWith(TX, orderIn(OrderStatus.PENDING), saga, expect.anything(), {
      now: expect.any(Date) as unknown,
      eventId: EVENT_ID,
    });
    expect(rewritten()).toMatchObject({
      step: CheckoutSagaStep.COMPENSATING,
      pendingCompensations: [Compensation.RELEASE_STOCK, Compensation.CANCEL_PAYMENT],
      wake: 'now',
      order: { status: OrderStatus.CANCELLED, reason: 'user:cancel' },
    });
  });

  it('records an admin cancel under its own reason', async () => {
    const { useCase, rewritten } = build(orderIn(OrderStatus.PENDING));

    await useCase.cancelAsAdmin(ORDER_ID);

    expect(rewritten()?.order).toEqual({ status: OrderStatus.CANCELLED, reason: 'admin:cancel' });
  });

  it('still answers with the cancelled order when the compensation fails, leaving it to the runner', async () => {
    const { useCase, advance, logError } = build(orderIn(OrderStatus.PENDING));
    advance.execute.mockRejectedValueOnce(new Error('gateway unavailable'));

    await expect(useCase.cancelOwn(ORDER_ID, OWNER)).resolves.toMatchObject({ status: OrderStatus.CANCELLED });
    expect(logError).toHaveBeenCalled();
  });

  it('answers a repeat cancel with the cancelled order and nothing else', async () => {
    const { useCase, writer, advance } = build(orderIn(OrderStatus.CANCELLED));

    await expect(useCase.cancelOwn(ORDER_ID, OWNER)).resolves.toMatchObject({ status: OrderStatus.CANCELLED });
    expect(writer.rewrite).not.toHaveBeenCalled();
    expect(advance.execute).not.toHaveBeenCalled();
  });

  it.each([OrderStatus.CONFIRMING, OrderStatus.PAID, OrderStatus.FAILED, OrderStatus.EXPIRED])(
    'refuses an order in %s with 409',
    async (status) => {
      const { useCase, writer } = build(orderIn(status));

      await expect(useCase.cancelOwn(ORDER_ID, OWNER)).rejects.toBeInstanceOf(ConflictException);
      expect(writer.rewrite).not.toHaveBeenCalled();
    },
  );

  it("answers 404 to a buyer for someone else's order, a missing one, or one they cannot see yet", async () => {
    const cases = [
      [orderIn(OrderStatus.PENDING), STRANGER],
      [null, OWNER],
      [orderIn(OrderStatus.RESERVING), OWNER],
      [orderIn(OrderStatus.REJECTED), OWNER],
    ] as const;

    const statuses = await Promise.all(
      cases.map(([found, user]) => statusOf(build(found).useCase.cancelOwn(ORDER_ID, user))),
    );

    expect(statuses).toEqual([404, 404, 404, 404]);
  });

  it('lets an admin see a reserving order but not cancel it', async () => {
    const { useCase } = build(orderIn(OrderStatus.RESERVING));

    await expect(useCase.cancelAsAdmin(ORDER_ID)).rejects.toBeInstanceOf(ConflictException);
    await expect(build(null).useCase.cancelAsAdmin(ORDER_ID)).rejects.toBeInstanceOf(NotFoundException);
  });
});
