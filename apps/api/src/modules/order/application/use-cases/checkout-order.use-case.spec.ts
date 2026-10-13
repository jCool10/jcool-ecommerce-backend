import { ConflictException, HttpException, InternalServerErrorException } from '@nestjs/common';
import type { ClsService } from 'nestjs-cls';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeMetricsPort } from '@jcool/testing/fake-metrics-port';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import type { TryVerdict } from '../../domain/checkout-saga';
import { Order } from '../../domain/order.entity';
import { OrderItem } from '../../domain/order-item.entity';
import { OrderStatus } from '../../domain/order-status';
import { checkoutSagaSettings } from '../../testing/checkout-saga-settings.double';
import { CheckoutUnavailableException } from '../checkout-unavailable.exception';
import type { CartSnapshotReaderPort, OrderCartLine } from '../ports/cart-snapshot.port';
import type { CatalogQueryPort, OrderSkuView } from '../ports/catalog-query.port';
import {
  CheckoutEngineUnavailableError,
  type CheckoutSagaEnginePort,
  type CheckoutStart,
} from '../ports/checkout-saga-engine.port';
import type { IdempotencyStorePort } from '../ports/idempotency-store.port';
import { TooManyPendingOrdersError, type OrderRepositoryPort } from '../ports/order-repository.port';
import { CheckoutOrderUseCase } from './checkout-order.use-case';

const SKU = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_SKU = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SCOPE = 'user:u1';
const KEY = '9f8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const ORDER_ID = 'order-1';
const NOW = new Date('2026-03-01T09:00:00.000Z');
const settings = checkoutSagaSettings();
const DEADLINE = new Date(NOW.getTime() + settings.paymentDeadlineMs);
const RETRY_AFTER_SEC = Math.ceil(settings.reserveWaitMs / 1000);

function skuView(overrides: Partial<OrderSkuView> = {}): OrderSkuView {
  return { skuId: SKU, productName: 'Widget', unitPriceMinor: 100_000, currency: 'VND', isActive: true, ...overrides };
}

const TWO_LINES: OrderCartLine[] = [
  { skuId: SKU, quantity: 1 },
  { skuId: OTHER_SKU, quantity: 1 },
];

const existingIn = (status: OrderStatus): Order =>
  Order.rehydrate({
    id: 'order-existing',
    userId: 'u1',
    status,
    currency: 'VND',
    items: [OrderItem.of(SKU, 'Widget', 100_000, 2)],
    totalAmountMinor: 200_000,
    placedAt: new Date('2026-02-28T00:00:00.000Z'),
    paymentDeadlineAt: new Date('2026-02-28T01:00:00.000Z'),
  });

function build(
  opts: {
    lines?: OrderCartLine[];
    /** The whole batch result verbatim; a SKU absent from it is one Catalog no longer knows. */
    views?: OrderSkuView[];
    noContext?: boolean;
  } = {},
) {
  const orders = {
    createReserving: vi.fn<OrderRepositoryPort['createReserving']>(() =>
      Promise.resolve({ orderId: ORDER_ID, created: true }),
    ),
    findById: vi.fn<OrderRepositoryPort['findById']>(),
  };
  const engine = {
    reserve: vi.fn<CheckoutSagaEnginePort['reserve']>(() => Promise.resolve('HELD')),
  };
  const idempotency = { markCompleted: vi.fn().mockResolvedValue(undefined), deleteInProgress: vi.fn() };
  const metrics = fakeMetricsPort();
  const logError = vi.fn();
  const cls = {
    isActive: () => !opts.noContext,
    get: () => ({ scope: SCOPE, key: KEY }),
  } as unknown as ClsService;
  const cart: CartSnapshotReaderPort = {
    getLines: vi.fn().mockResolvedValue(opts.lines ?? [{ skuId: SKU, quantity: 2 }]),
  };
  const catalog: CatalogQueryPort = { getSkuViews: vi.fn().mockResolvedValue(opts.views ?? [skuView()]) };

  const useCase = new CheckoutOrderUseCase(
    orders as unknown as OrderRepositoryPort,
    engine as unknown as CheckoutSagaEnginePort,
    cart,
    catalog,
    idempotency as unknown as IdempotencyStorePort,
    settings,
    metrics,
    cls,
    fakePinoLogger({ error: logError }),
  );
  return { useCase, orders, engine, idempotency, metrics, logError };
}

const failure = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => 'resolved',
    (error: unknown) => error,
  );

describe('CheckoutOrderUseCase', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects a cart it cannot price as one order with 400, never opening the checkout', async () => {
    const carts: Record<string, Parameters<typeof build>[0]> = {
      empty: { lines: [] },
      'mixed currency': { lines: TWO_LINES, views: [skuView(), skuView({ skuId: OTHER_SKU, currency: 'USD' })] },
      unpriced: { views: [skuView({ unitPriceMinor: null })] },
      archived: { views: [skuView({ isActive: false })] },
      'one SKU gone': { lines: TWO_LINES, views: [skuView()] },
      'every SKU gone': { views: [] },
    };

    const outcomes = await Promise.all(
      Object.entries(carts).map(async ([label, opts]) => {
        const { useCase, orders } = build(opts);
        const error = await failure(useCase.execute('u1'));
        const status = error instanceof HttpException ? error.getStatus() : error;
        return [label, status, orders.createReserving.mock.calls.length];
      }),
    );

    expect(outcomes).toEqual(Object.keys(carts).map((label) => [label, 400, 0]));
  });

  it('prices each line from its own SKU, whatever order the batch read came back in', async () => {
    const { useCase } = build({
      lines: [
        { skuId: SKU, quantity: 1 },
        { skuId: OTHER_SKU, quantity: 2 },
      ],
      views: [skuView({ skuId: OTHER_SKU, productName: 'Gadget', unitPriceMinor: 50_000 }), skuView()],
    });

    const view = await useCase.execute('u1');

    expect(view.totalAmountMinor).toBe(100_000 * 1 + 50_000 * 2);
    expect(view.items).toEqual([
      expect.objectContaining({ skuId: SKU, productName: 'Widget', unitPriceMinor: 100_000, quantity: 1 }),
      expect.objectContaining({ skuId: OTHER_SKU, productName: 'Gadget', unitPriceMinor: 50_000, quantity: 2 }),
    ]);
  });

  it('fails loud (500) when the idempotency context is missing, never opening the checkout', async () => {
    const { useCase, orders } = build({ noContext: true });

    await expect(useCase.execute('u1')).rejects.toBeInstanceOf(InternalServerErrorException);
    expect(orders.createReserving).not.toHaveBeenCalled();
  });

  describe('a held Try', () => {
    it('writes the reserving order with its deadline, then hands the saga everything the Try needs', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(NOW);
      const { useCase, orders, engine } = build();

      await useCase.execute('u1');

      const [order, key] = orders.createReserving.mock.calls[0];
      expect(order).toMatchObject({
        status: OrderStatus.RESERVING,
        userId: 'u1',
        placedAt: NOW,
        paymentDeadlineAt: DEADLINE,
      });
      expect(key).toBe(KEY);
      expect(engine.reserve).toHaveBeenCalledExactlyOnceWith({
        orderId: ORDER_ID,
        lines: [{ skuId: SKU, quantity: 2 }],
        totalMinor: 200_000,
        currency: 'VND',
        placedAt: NOW,
        deadlineAt: DEADLINE,
        holdUntil: new Date(DEADLINE.getTime() + settings.holdSafetyMs),
        idempotency: { scope: SCOPE, key: KEY },
      } satisfies CheckoutStart);
      expect(orders.createReserving.mock.invocationCallOrder[0]).toBeLessThan(
        engine.reserve.mock.invocationCallOrder[0],
      );
    });

    it('answers the placed order and leaves completing the key to the saga', async () => {
      const { useCase, idempotency, metrics } = build();

      const view = await useCase.execute('u1');

      expect(view).toMatchObject({
        id: ORDER_ID,
        status: OrderStatus.PENDING,
        currency: 'VND',
        totalAmountMinor: 200_000,
      });
      expect(idempotency.markCompleted).not.toHaveBeenCalled();
      expect(metrics.recordOrderCreated).toHaveBeenCalledExactlyOnceWith(OrderStatus.PENDING);
      expect(metrics.observeOrderValue).toHaveBeenCalledExactlyOnceWith(200_000);
    });
  });

  it.each<TryVerdict>(['OUT_OF_STOCK', 'CONTENDED', 'CONFLICT'])(
    'answers %s with a generic 409, the saga having already freed the key',
    async (verdict) => {
      const { useCase, engine, idempotency, metrics } = build();
      engine.reserve.mockResolvedValueOnce(verdict);

      const error = await failure(useCase.execute('u1'));

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).message).toBe('Insufficient stock');
      expect(idempotency.deleteInProgress).not.toHaveBeenCalled();
      expect(idempotency.markCompleted).not.toHaveBeenCalled();
      expect(metrics.recordOrderCreated).not.toHaveBeenCalled();
    },
  );

  it.each<TryVerdict>(['TIMEOUT', 'ERROR', 'ABANDONED'])(
    'answers %s with 503 and Retry-After, the saga having already freed the key',
    async (verdict) => {
      const { useCase, engine, idempotency } = build();
      engine.reserve.mockResolvedValueOnce(verdict);

      const error = await failure(useCase.execute('u1'));

      expect(error).toBeInstanceOf(CheckoutUnavailableException);
      expect((error as CheckoutUnavailableException).retryAfterSec).toBe(RETRY_AFTER_SEC);
      expect(idempotency.deleteInProgress).not.toHaveBeenCalled();
    },
  );

  // Freeing the key here would let a retry place a second order while the first saga still runs.
  it('answers 503 with Retry-After and keeps the key when the engine does not answer', async () => {
    const { useCase, engine, idempotency, logError } = build();
    engine.reserve.mockRejectedValueOnce(new CheckoutEngineUnavailableError('reserve'));

    const error = await failure(useCase.execute('u1'));

    expect(error).toBeInstanceOf(CheckoutUnavailableException);
    expect((error as CheckoutUnavailableException).retryAfterSec).toBe(RETRY_AFTER_SEC);
    expect(idempotency.deleteInProgress).not.toHaveBeenCalled();
    expect(idempotency.markCompleted).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledWith(expect.objectContaining({ orderId: ORDER_ID }), expect.any(String));
  });

  it('lets an unexpected engine failure through as itself', async () => {
    const { useCase, engine } = build();
    const bug = new TypeError('bad input');
    engine.reserve.mockRejectedValueOnce(bug);

    await expect(useCase.execute('u1')).rejects.toBe(bug);
  });

  it('answers a pending-order cap breach with 409 before the saga starts', async () => {
    const { useCase, orders, engine } = build();
    orders.createReserving.mockRejectedValueOnce(new TooManyPendingOrdersError('u1', 3));

    const error = await failure(useCase.execute('u1'));

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).message).toContain('Too many pending orders');
    expect(engine.reserve).not.toHaveBeenCalled();
  });

  describe('a key that already placed an order', () => {
    it('rejoins the saga of an order still reserving, under the same order id', async () => {
      const { useCase, orders, engine } = build();
      const reserving = existingIn(OrderStatus.RESERVING);
      orders.createReserving.mockResolvedValueOnce({ orderId: 'order-existing', created: false });
      orders.findById.mockResolvedValueOnce(reserving);

      const view = await useCase.execute('u1');

      expect(view).toMatchObject({ id: 'order-existing', status: OrderStatus.PENDING });
      expect(engine.reserve).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          orderId: 'order-existing',
          placedAt: reserving.placedAt,
          deadlineAt: reserving.paymentDeadlineAt,
          idempotency: { scope: SCOPE, key: KEY },
        }),
      );
    });

    it('replays a placed order without starting a saga', async () => {
      const { useCase, orders, engine, idempotency, metrics } = build();
      orders.createReserving.mockResolvedValueOnce({ orderId: 'order-existing', created: false });
      orders.findById.mockResolvedValueOnce(existingIn(OrderStatus.PENDING));

      const view = await useCase.execute('u1');

      expect(view).toMatchObject({ id: 'order-existing', status: OrderStatus.PENDING });
      expect(engine.reserve).not.toHaveBeenCalled();
      expect(idempotency.markCompleted).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ scope: SCOPE, key: KEY, orderId: 'order-existing', responseBody: view }),
      );
      expect(metrics.recordOrderCreated).not.toHaveBeenCalled();
    });

    it('never replays an order rejected after the key matched it, asking for a retry instead', async () => {
      const { useCase, orders, engine, idempotency } = build();
      orders.createReserving.mockResolvedValueOnce({ orderId: 'order-existing', created: false });
      orders.findById.mockResolvedValueOnce(existingIn(OrderStatus.REJECTED));

      const error = await failure(useCase.execute('u1'));

      expect(error).toBeInstanceOf(CheckoutUnavailableException);
      expect((error as CheckoutUnavailableException).retryAfterSec).toBe(RETRY_AFTER_SEC);
      expect(engine.reserve).not.toHaveBeenCalled();
      expect(idempotency.markCompleted).not.toHaveBeenCalled();
    });
  });
});
