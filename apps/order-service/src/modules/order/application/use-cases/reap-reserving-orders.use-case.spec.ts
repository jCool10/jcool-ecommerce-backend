import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { Order } from '../../domain/order.entity';
import { OrderItem } from '../../domain/order-item.entity';
import { OrderStatus } from '../../domain/order-status';
import {
  CheckoutEngineUnavailableError,
  CheckoutSagaClosedError,
  type CheckoutSagaEnginePort,
} from '../ports/checkout-saga-engine.port';
import type { OrderRepositoryPort } from '../ports/order-repository.port';
import { REAP_BATCH_SIZE, ReapReservingOrdersUseCase } from './reap-reserving-orders.use-case';

const NOW = new Date('2026-10-20T08:10:00.000Z');
const ORPHAN_SEC = 60;

function reserving(id: string): Order {
  return Order.rehydrate({
    id,
    userId: 'u1',
    status: OrderStatus.RESERVING,
    currency: 'VND',
    items: [OrderItem.of('sku-1', 'Widget', 100_000, 1)],
    totalAmountMinor: 100_000,
    placedAt: new Date('2026-10-20T08:00:00.000Z'),
    paymentDeadlineAt: new Date('2026-10-20T09:00:00.000Z'),
  });
}

function build(orders: Order[], failures: Record<string, Error> = {}) {
  const findReservingOlderThan = vi.fn().mockResolvedValue(orders);
  const ensureStarted = vi.fn(({ orderId }: { orderId: string }) =>
    failures[orderId] ? Promise.reject(failures[orderId]) : Promise.resolve(),
  );
  const logger = { warn: vi.fn(), error: vi.fn() };
  const useCase = new ReapReservingOrdersUseCase(
    { findReservingOlderThan } as unknown as OrderRepositoryPort,
    { ensureStarted } as unknown as CheckoutSagaEnginePort,
    fakeConfigService({ checkoutSaga: { reservingOrphanSec: ORPHAN_SEC } }),
    fakePinoLogger(logger),
  );
  return { useCase, findReservingOlderThan, ensureStarted, logger };
}

const startedFor = (ensureStarted: ReturnType<typeof build>['ensureStarted']) =>
  ensureStarted.mock.calls.map(([start]) => start.orderId);

describe('ReapReservingOrdersUseCase', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('asks only for orders older than the orphan threshold, one bounded batch at a time', async () => {
    const { useCase, findReservingOlderThan } = build([]);

    await useCase.execute();

    expect(findReservingOlderThan).toHaveBeenCalledExactlyOnceWith(
      new Date(NOW.getTime() - ORPHAN_SEC * 1000),
      REAP_BATCH_SIZE,
    );
  });

  it("hands each orphan back to its saga with the order's own checkout start", async () => {
    const { useCase, ensureStarted } = build([reserving('o-1'), reserving('o-2')]);

    expect(await useCase.execute()).toEqual({ found: 2, handedBack: 2 });
    expect(startedFor(ensureStarted)).toEqual(['o-1', 'o-2']);
    expect(ensureStarted.mock.calls[0][0]).toMatchObject({ mode: 'checkout', orderId: 'o-1', totalMinor: 100_000 });
  });

  // Every later order would wait out the same timeout against an engine that is down.
  it('stops the batch at the first order the engine cannot take, warning once', async () => {
    const { useCase, ensureStarted, logger } = build([reserving('o-1'), reserving('o-2'), reserving('o-3')], {
      'o-2': new CheckoutEngineUnavailableError(),
    });

    expect(await useCase.execute()).toEqual({ found: 3, handedBack: 1 });
    expect(startedFor(ensureStarted)).toEqual(['o-1', 'o-2']);
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('reports an orphan whose saga has already closed, and goes on', async () => {
    const { useCase, ensureStarted, logger } = build([reserving('o-1'), reserving('o-2')], {
      'o-1': new CheckoutSagaClosedError('o-1'),
    });

    expect(await useCase.execute()).toEqual({ found: 2, handedBack: 1 });
    expect(startedFor(ensureStarted)).toEqual(['o-1', 'o-2']);
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ orderId: 'o-1' }), expect.any(String));
  });

  it('lets an unexpected fault through', async () => {
    const boom = new Error('boom');
    const { useCase } = build([reserving('o-1')], { 'o-1': boom });

    await expect(useCase.execute()).rejects.toBe(boom);
  });
});
