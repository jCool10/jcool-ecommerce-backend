import { ConflictException, HttpException, InternalServerErrorException } from '@nestjs/common';
import type { ClsService } from 'nestjs-cls';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeMetricsPort } from '@jcool/testing/fake-metrics-port';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import type { DrizzleTx } from '@shared/infrastructure/database/drizzle.tokens';
import { CheckoutSagaStep, Compensation } from '../../domain/checkout-saga-step';
import type { SagaTransition } from '../../domain/checkout-saga';
import { Order } from '../../domain/order.entity';
import { OrderItem } from '../../domain/order-item.entity';
import { OrderStatus } from '../../domain/order-status';
import { CheckoutUnavailableException } from '../checkout-unavailable.exception';
import type { CartSnapshotReaderPort, OrderCartLine } from '../ports/cart-snapshot.port';
import type { CatalogQueryPort, OrderSkuView } from '../ports/catalog-query.port';
import type { CheckoutSaga, CheckoutSagaRepositoryPort } from '../ports/checkout-saga-repository.port';
import type { IdempotencyStorePort } from '../ports/idempotency-store.port';
import type { InventoryTccPort, ReserveOutcome } from '../ports/inventory-participant.port';
import { TooManyPendingOrdersError, type OrderRepositoryPort } from '../ports/order-repository.port';
import type { CheckoutSagaSettings } from '../saga/checkout-saga.settings';
import type { ApplyLeasedOptions, CheckoutSagaWriter } from '../saga/checkout-saga.writer';
import type { AdvanceCheckoutSagaUseCase } from './advance-checkout-saga.use-case';
import { CheckoutOrderUseCase } from './checkout-order.use-case';

const SKU = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_SKU = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SCOPE = 'user:u1';
const KEY = '9f8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const ORDER_ID = 'order-1';
const TX = { tx: true } as unknown as DrizzleTx;
const NOW = new Date('2026-03-01T09:00:00.000Z');
const settings: CheckoutSagaSettings = {
  leaseMs: 60_000,
  timing: { authGraceMs: 180_000, retryBaseMs: 1_000, retryCapMs: 300_000 },
  paymentDeadlineMs: 3_600_000,
  payCutoffMs: 1_980_000,
  tryTimeoutMs: 3_000,
  holdSafetyMs: 3_600_000,
};
const DEADLINE = new Date(NOW.getTime() + settings.paymentDeadlineMs);

function skuView(overrides: Partial<OrderSkuView> = {}): OrderSkuView {
  return { skuId: SKU, productName: 'Widget', unitPriceMinor: 100_000, currency: 'VND', isActive: true, ...overrides };
}

const TWO_LINES: OrderCartLine[] = [
  { skuId: SKU, quantity: 1 },
  { skuId: OTHER_SKU, quantity: 1 },
];

const leaseFor = (orderId: string, deadlineAt: Date): CheckoutSaga => ({
  orderId,
  step: CheckoutSagaStep.RESERVING,
  pendingCompensations: [],
  deadlineAt,
  nextAttemptAt: new Date(NOW.getTime() + settings.leaseMs),
  attempts: 0,
  leaseUntil: new Date(NOW.getTime() + settings.leaseMs),
  lastError: null,
  version: 1,
});

const existingIn = (status: OrderStatus): Order =>
  Order.rehydrate({
    id: 'order-existing',
    userId: 'u1',
    status,
    currency: 'VND',
    items: [OrderItem.of(SKU, 'Widget', 100_000, 2)],
    totalAmountMinor: 200_000,
    placedAt: new Date('2026-02-28T00:00:00.000Z'),
  });

function build(
  opts: {
    lines?: OrderCartLine[];
    /** The whole batch result verbatim; a SKU absent from it is one Catalog no longer knows. */
    views?: OrderSkuView[];
    noContext?: boolean;
  } = {},
) {
  const log: string[] = [];
  const orders = {
    createReserving: vi.fn(
      async (_order: Order, _key: string | null, insertSaga: (tx: DrizzleTx, id: string) => Promise<CheckoutSaga>) => {
        log.push('tx A');
        return { orderId: ORDER_ID, created: true as const, saga: await insertSaga(TX, ORDER_ID) };
      },
    ),
    findById: vi.fn(),
  };
  const sagas = {
    insertLeased: vi.fn((_tx: DrizzleTx, input: { orderId: string; deadlineAt: Date }) =>
      Promise.resolve(leaseFor(input.orderId, input.deadlineAt)),
    ),
  };
  const writer = {
    applyLeased: vi.fn(async (_lease: CheckoutSaga, transition: SagaTransition, options?: ApplyLeasedOptions) => {
      log.push(`tx B ${transition.step}`);
      await options?.inTx?.(TX, null);
      return true;
    }),
  };
  const advance = {
    execute: vi.fn(() => {
      log.push('advance');
      return Promise.resolve();
    }),
  };
  const inventory = {
    tryReserve: vi.fn((): Promise<ReserveOutcome> => {
      log.push('try');
      return Promise.resolve('HELD');
    }),
  };
  const markCompleted = vi.fn().mockResolvedValue(undefined);
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
    sagas as unknown as CheckoutSagaRepositoryPort,
    writer as unknown as CheckoutSagaWriter,
    advance as unknown as AdvanceCheckoutSagaUseCase,
    cart,
    catalog,
    inventory as unknown as InventoryTccPort,
    { markCompleted } as unknown as IdempotencyStorePort,
    settings,
    metrics,
    cls,
    fakePinoLogger({ error: logError }),
  );
  const applied = () => writer.applyLeased.mock.calls.map(([lease, transition]) => ({ lease, transition }));
  return { useCase, orders, sagas, writer, advance, inventory, markCompleted, metrics, logError, log, applied };
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
    it('reserves under a leased saga, asks for stock outside any transaction, then places the order', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(NOW);
      const { useCase, orders, sagas, inventory, log, applied } = build();

      await useCase.execute('u1');

      expect(log).toEqual(['tx A', 'try', `tx B ${CheckoutSagaStep.AWAITING_AUTH}`]);
      const [order, key] = orders.createReserving.mock.calls[0];
      expect(order).toMatchObject({ status: OrderStatus.RESERVING, placedAt: NOW, userId: 'u1' });
      expect(key).toBe(KEY);
      expect(sagas.insertLeased).toHaveBeenCalledWith(TX, {
        orderId: ORDER_ID,
        deadlineAt: DEADLINE,
        leaseMs: settings.leaseMs,
      });
      expect(inventory.tryReserve).toHaveBeenCalledWith({
        orderId: ORDER_ID,
        lines: [{ skuId: SKU, quantity: 2 }],
        holdUntil: new Date(DEADLINE.getTime() + settings.holdSafetyMs),
      });
      expect(applied()[0].lease).toEqual(leaseFor(ORDER_ID, DEADLINE));
      expect(applied()[0].transition.order).toEqual({ status: OrderStatus.PENDING });
    });

    it('answers PENDING and completes the key inside the transaction that places the order', async () => {
      const { useCase, markCompleted, metrics } = build();

      const view = await useCase.execute('u1');

      expect(view).toMatchObject({
        id: ORDER_ID,
        status: OrderStatus.PENDING,
        currency: 'VND',
        totalAmountMinor: 200_000,
      });
      // The cached replay must be byte-identical to the first response.
      expect(markCompleted).toHaveBeenCalledExactlyOnceWith(
        { scope: SCOPE, key: KEY, responseStatus: 201, orderId: ORDER_ID, responseBody: view },
        TX,
      );
      expect(metrics.recordSagaStep).toHaveBeenCalledExactlyOnceWith('try_reserve', 'success');
      expect(metrics.recordOrderCreated).toHaveBeenCalledExactlyOnceWith(OrderStatus.PENDING);
      expect(metrics.observeOrderValue).toHaveBeenCalledExactlyOnceWith(200_000);
    });
  });

  it.each<ReserveOutcome>(['OUT_OF_STOCK', 'CONTENDED', 'CONFLICT'])(
    'rejects the order on %s and answers a generic 409 once that has committed',
    async (outcome) => {
      const { useCase, inventory, markCompleted, metrics, advance, applied } = build();
      inventory.tryReserve.mockResolvedValueOnce(outcome);

      const error = await failure(useCase.execute('u1'));

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).message).toBe('Insufficient stock');
      expect(applied()[0].transition).toMatchObject({
        step: CheckoutSagaStep.COMPENSATED,
        order: { status: OrderStatus.REJECTED, reason: `try:${outcome.toLowerCase()}` },
      });
      expect(markCompleted).not.toHaveBeenCalled();
      expect(advance.execute).not.toHaveBeenCalled();
      expect(metrics.recordSagaStep).toHaveBeenCalledExactlyOnceWith('try_reserve', 'failed');
      expect(metrics.recordOrderCreated).not.toHaveBeenCalled();
    },
  );

  describe('a Try with no answer', () => {
    it('rejects after the timeout, releases inline once that has committed, and answers 503 with Retry-After', async () => {
      vi.useFakeTimers();
      const { useCase, inventory, log, applied, markCompleted } = build();
      inventory.tryReserve.mockImplementationOnce(() => new Promise(() => undefined));

      const outcome = failure(useCase.execute('u1'));
      await vi.advanceTimersByTimeAsync(settings.tryTimeoutMs);
      const error = await outcome;

      expect(error).toBeInstanceOf(CheckoutUnavailableException);
      expect((error as CheckoutUnavailableException).retryAfterSec).toBe(3);
      expect(applied()[0].transition).toMatchObject({
        step: CheckoutSagaStep.COMPENSATING,
        pendingCompensations: [Compensation.RELEASE_STOCK],
        order: { status: OrderStatus.REJECTED, reason: 'try:timeout' },
      });
      expect(log).toEqual(['tx A', `tx B ${CheckoutSagaStep.COMPENSATING}`, 'advance']);
      expect(markCompleted).not.toHaveBeenCalled();
    });

    it('treats a Try that throws as one that never answered', async () => {
      const { useCase, inventory, applied, advance, metrics } = build();
      inventory.tryReserve.mockRejectedValueOnce(new Error('pool exhausted'));

      const error = await failure(useCase.execute('u1'));

      expect(error).toBeInstanceOf(CheckoutUnavailableException);
      expect(applied()[0].transition.order).toEqual({ status: OrderStatus.REJECTED, reason: 'try:error' });
      expect(advance.execute).toHaveBeenCalledWith(ORDER_ID);
      expect(metrics.recordSagaStep).toHaveBeenCalledExactlyOnceWith('try_reserve', 'failed');
    });

    it('still answers 503 when the inline release fails, leaving it to the runner', async () => {
      const { useCase, inventory, advance, logError } = build();
      inventory.tryReserve.mockRejectedValueOnce(new Error('pool exhausted'));
      advance.execute.mockRejectedValueOnce(new Error('db gone'));

      const error = await failure(useCase.execute('u1'));

      expect(error).toBeInstanceOf(CheckoutUnavailableException);
      expect(logError).toHaveBeenCalled();
    });

    it('stops waiting on the inline release after about a second', async () => {
      vi.useFakeTimers();
      const { useCase, inventory, advance } = build();
      inventory.tryReserve.mockRejectedValueOnce(new Error('pool exhausted'));
      advance.execute.mockImplementationOnce(() => new Promise(() => undefined));
      let settled = false;

      const outcome = failure(useCase.execute('u1')).finally(() => (settled = true));
      await vi.advanceTimersByTimeAsync(999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      expect(await outcome).toBeInstanceOf(CheckoutUnavailableException);
    });

    it('lets a Try that fails after the timeout go without an unhandled rejection', async () => {
      vi.useFakeTimers();
      const { useCase, inventory } = build();
      let fail!: (error: Error) => void;
      inventory.tryReserve.mockImplementationOnce(() => new Promise((_resolve, reject) => (fail = reject)));

      const outcome = failure(useCase.execute('u1'));
      await vi.advanceTimersByTimeAsync(settings.tryTimeoutMs);
      await outcome;
      fail(new Error('late'));
      await vi.advanceTimersByTimeAsync(0);
    });
  });

  it('answers 503 and writes nothing more once the runner has taken the saga from under tx B', async () => {
    const { useCase, writer, markCompleted, advance, metrics } = build();
    writer.applyLeased.mockResolvedValueOnce(false);

    const error = await failure(useCase.execute('u1'));

    expect(error).toBeInstanceOf(CheckoutUnavailableException);
    expect(markCompleted).not.toHaveBeenCalled();
    expect(advance.execute).not.toHaveBeenCalled();
    expect(metrics.recordOrderCreated).not.toHaveBeenCalled();
  });

  it('answers a pending-order cap breach with 409 before asking for any stock', async () => {
    const { useCase, orders, inventory } = build();
    orders.createReserving.mockRejectedValueOnce(new TooManyPendingOrdersError('u1', 3));

    const error = await failure(useCase.execute('u1'));

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).message).toContain('Too many pending orders');
    expect(inventory.tryReserve).not.toHaveBeenCalled();
  });

  describe('a key that already placed an order', () => {
    it('answers 503 with Retry-After while that order is still reserving', async () => {
      const { useCase, orders, inventory, markCompleted } = build();
      orders.createReserving.mockResolvedValueOnce({ orderId: 'order-existing', created: false } as never);
      orders.findById.mockResolvedValueOnce(existingIn(OrderStatus.RESERVING));

      const error = await failure(useCase.execute('u1'));

      expect(error).toBeInstanceOf(CheckoutUnavailableException);
      expect((error as CheckoutUnavailableException).retryAfterSec).toBe(3);
      expect(inventory.tryReserve).not.toHaveBeenCalled();
      expect(markCompleted).not.toHaveBeenCalled();
    });

    it('replays it once it is placed, without a second Try', async () => {
      const { useCase, orders, inventory, writer, markCompleted, metrics } = build();
      orders.createReserving.mockResolvedValueOnce({ orderId: 'order-existing', created: false } as never);
      orders.findById.mockResolvedValueOnce(existingIn(OrderStatus.PENDING));

      const view = await useCase.execute('u1');

      expect(view).toMatchObject({ id: 'order-existing', status: OrderStatus.PENDING });
      expect(inventory.tryReserve).not.toHaveBeenCalled();
      expect(writer.applyLeased).not.toHaveBeenCalled();
      // No tx argument: the checkout transaction never opened, so the heal writes on its own.
      expect(markCompleted).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ scope: SCOPE, key: KEY, orderId: 'order-existing', responseBody: view }),
      );
      expect(metrics.recordOrderCreated).not.toHaveBeenCalled();
      expect(metrics.recordSagaStep).not.toHaveBeenCalled();
    });
  });
});
