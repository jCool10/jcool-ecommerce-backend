import { ConflictException, HttpException, InternalServerErrorException } from '@nestjs/common';
import type { ClsService } from 'nestjs-cls';
import { describe, expect, it, vi } from 'vitest';
import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { fakeMetricsPort } from '@jcool/testing/fake-metrics-port';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import type { ReserveOutcome } from '../../domain/checkout-saga';
import { Order } from '../../domain/order.entity';
import { OrderItem } from '../../domain/order-item.entity';
import { OrderStatus } from '../../domain/order-status';
import { CheckoutUnavailableError } from '../checkout-unavailable.error';
import type { CartSnapshotReaderPort, OrderCartLine } from '../ports/cart-snapshot.port';
import type { CatalogQueryPort, OrderSkuView } from '../ports/catalog-query.port';
import {
  CheckoutEngineUnavailableError,
  CheckoutSagaClosedError,
  type CheckoutSagaEnginePort,
} from '../ports/checkout-saga-engine.port';
import type { IdempotencyStorePort } from '../ports/idempotency-store.port';
import { TooManyPendingOrdersError, type OrderRepositoryPort } from '../ports/order-repository.port';
import { CheckoutOrderUseCase } from './checkout-order.use-case';

const SKU = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_SKU = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SCOPE = 'user:u1';
const KEY = '9f8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const DEADLINE_SEC = 3600;
const PLACED_AT = new Date('2026-10-20T08:00:00.000Z');

function skuView(overrides: Partial<OrderSkuView> = {}): OrderSkuView {
  return { skuId: SKU, productName: 'Widget', unitPriceMinor: 100_000, currency: 'VND', isActive: true, ...overrides };
}

const TWO_LINES: OrderCartLine[] = [
  { skuId: SKU, quantity: 1 },
  { skuId: OTHER_SKU, quantity: 1 },
];

function savedOrder(status: OrderStatus, id = 'order-1'): Order {
  return Order.rehydrate({
    id,
    userId: 'u1',
    status,
    currency: 'VND',
    items: [OrderItem.of(SKU, 'Widget', 100_000, 2)],
    totalAmountMinor: 200_000,
    placedAt: PLACED_AT,
    paymentDeadlineAt: new Date(PLACED_AT.getTime() + DEADLINE_SEC * 1000),
  });
}

function build(
  opts: {
    lines?: OrderCartLine[];
    views?: OrderSkuView[];
    /** What tx A finds or writes; `created` false means an order already carried the key. */
    existing?: Order;
    outcome?: ReserveOutcome | Error;
    /** The order as a re-read after the engine answers sees it. */
    reread?: Order;
    noContext?: boolean;
  } = {},
) {
  const createReserving = vi.fn(({ order }: { order: Order }) =>
    Promise.resolve(
      opts.existing
        ? { created: false, order: opts.existing }
        : { created: true, order: Order.rehydrate({ ...order, id: 'order-1', items: [...order.items] }) },
    ),
  );
  const findById = vi.fn().mockResolvedValue(opts.reread ?? null);
  const outcome = opts.outcome ?? 'HELD';
  const reserve = vi.fn(() => (outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome)));
  const markCompleted = vi.fn().mockResolvedValue(undefined);
  const metrics = fakeMetricsPort();

  const repo = { createReserving, findById } as unknown as OrderRepositoryPort;
  const cart: CartSnapshotReaderPort = {
    getLines: vi.fn().mockResolvedValue(opts.lines ?? [{ skuId: SKU, quantity: 2 }]),
  };
  const catalog: CatalogQueryPort = { getSkuViews: vi.fn().mockResolvedValue(opts.views ?? [skuView()]) };
  const engine = { reserve } as unknown as CheckoutSagaEnginePort;
  const store = { markCompleted } as unknown as IdempotencyStorePort;
  const cls = {
    isActive: () => !opts.noContext,
    get: () => ({ scope: SCOPE, key: KEY }),
  } as unknown as ClsService;
  const config = fakeConfigService({ checkoutSaga: { paymentDeadlineSec: DEADLINE_SEC } });

  const useCase = new CheckoutOrderUseCase(repo, cart, catalog, engine, store, metrics, config, cls, fakePinoLogger());
  return { useCase, spies: { createReserving, findById, reserve, markCompleted }, metrics };
}

const statusOf = (promise: Promise<unknown>) =>
  promise.then(
    () => 'resolved',
    (error: unknown) => {
      if (error instanceof HttpException) return error.getStatus();
      if (error instanceof CheckoutUnavailableError) return 503;
      return error;
    },
  );

describe('CheckoutOrderUseCase', () => {
  it('rejects a cart it cannot price as one order with 400, never writing an order', async () => {
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
        const { useCase, spies } = build(opts);
        return [label, await statusOf(useCase.execute('u1')), spies.createReserving.mock.calls.length];
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

  it('fails loud (500) when the idempotency context is missing, never writing an order', async () => {
    const { useCase, spies } = build({ noContext: true });

    await expect(useCase.execute('u1')).rejects.toBeInstanceOf(InternalServerErrorException);
    expect(spies.createReserving).not.toHaveBeenCalled();
  });

  it('writes the order RESERVING under the key, with its payment deadline', async () => {
    const { useCase, spies } = build();
    const before = Date.now();

    await useCase.execute('u1');

    const [{ order, idempotencyKey }] = spies.createReserving.mock.calls[0] as unknown as [
      { order: Order; idempotencyKey: string },
    ];
    expect(idempotencyKey).toBe(KEY);
    expect(order.status).toBe(OrderStatus.RESERVING);
    const placedAt = (order.placedAt as Date).getTime();
    expect(placedAt).toBeGreaterThanOrEqual(before);
    expect(order.paymentDeadlineAt?.getTime()).toBe(placedAt + DEADLINE_SEC * 1000);
  });

  it('starts the saga from the saved order', async () => {
    const { useCase, spies } = build();

    await useCase.execute('u1');

    const [start] = spies.reserve.mock.calls[0] as unknown as [Record<string, unknown>];
    const [{ order }] = spies.createReserving.mock.calls[0] as unknown as [{ order: Order }];
    expect(start).toEqual({
      mode: 'checkout',
      orderId: 'order-1',
      userId: 'u1',
      lines: [{ skuId: SKU, quantity: 2 }],
      totalMinor: 200_000,
      currency: 'VND',
      placedAt: order.placedAt,
      deadlineAt: order.paymentDeadlineAt,
    });
  });

  it('answers a held order as PENDING and counts it as created', async () => {
    const { useCase, spies, metrics } = build();

    const view = await useCase.execute('u1');

    expect(view).toMatchObject({ id: 'order-1', status: OrderStatus.PENDING, totalAmountMinor: 200_000 });
    expect(view.finalizeReason).toBeNull();
    // tx B froze the key with this body; nothing else writes it.
    expect(spies.markCompleted).not.toHaveBeenCalled();
    expect(metrics.recordOrderCreated).toHaveBeenCalledExactlyOnceWith(OrderStatus.PENDING);
    expect(metrics.observeOrderValue).toHaveBeenCalledExactlyOnceWith(200_000);
  });

  it('answers 409 Insufficient stock to every refusal of the Try', async () => {
    const outcomes: ReserveOutcome[] = ['OUT_OF_STOCK', 'CONTENDED', 'CONFLICT'];

    for (const outcome of outcomes) {
      const { useCase, metrics } = build({ outcome });
      const error: unknown = await useCase.execute('u1').catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).message).toBe('Insufficient stock');
      expect(metrics.recordOrderCreated).not.toHaveBeenCalled();
    }
  });

  it('answers 503 when the Try could not answer in time', async () => {
    const outcomes: ReserveOutcome[] = ['TIMEOUT', 'ERROR', 'ABANDONED'];

    const statuses = await Promise.all(outcomes.map((outcome) => statusOf(build({ outcome }).useCase.execute('u1'))));

    expect(statuses).toEqual([503, 503, 503]);
  });

  it('answers 503 when the engine is unavailable, leaving the order for a retry to heal', async () => {
    const { useCase, spies } = build({ outcome: new CheckoutEngineUnavailableError() });

    expect(await statusOf(useCase.execute('u1'))).toBe(503);
    expect(spies.markCompleted).not.toHaveBeenCalled();
  });

  it('answers 409 at the in-flight cap, before any saga starts', async () => {
    const { useCase, spies } = build();
    spies.createReserving.mockRejectedValueOnce(new TooManyPendingOrdersError('u1', 3));

    const error: unknown = await useCase.execute('u1').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).message).toContain('Too many pending orders');
    expect(spies.reserve).not.toHaveBeenCalled();
  });

  it('asks the saga again for an order the key left RESERVING, and freezes the key on success', async () => {
    const { useCase, spies, metrics } = build({ existing: savedOrder(OrderStatus.RESERVING, 'order-earlier') });

    const view = await useCase.execute('u1');

    expect(view).toMatchObject({ id: 'order-earlier', status: OrderStatus.PENDING });
    expect(spies.reserve).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ orderId: 'order-earlier' }));
    expect(spies.markCompleted).toHaveBeenCalledExactlyOnceWith({
      scope: SCOPE,
      key: KEY,
      responseStatus: 201,
      responseBody: view,
      orderId: 'order-earlier',
    });
    expect(metrics.recordOrderCreated).not.toHaveBeenCalled();
  });

  it('replays an order the key already placed, without asking the saga', async () => {
    const settled = [OrderStatus.PENDING, OrderStatus.CONFIRMING, OrderStatus.PAID, OrderStatus.CANCELLED];

    for (const status of settled) {
      const { useCase, spies } = build({ existing: savedOrder(status, 'order-earlier') });

      const view = await useCase.execute('u1');

      expect(view).toMatchObject({ id: 'order-earlier', status });
      expect(spies.reserve).not.toHaveBeenCalled();
      expect(spies.markCompleted).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ key: KEY, orderId: 'order-earlier', responseBody: view }),
      );
    }
  });

  it('answers 503 and caches nothing for an order that turns out REJECTED', async () => {
    const cases: Parameters<typeof build>[0][] = [
      { existing: savedOrder(OrderStatus.REJECTED) },
      { outcome: new CheckoutSagaClosedError('order-1'), reread: savedOrder(OrderStatus.REJECTED) },
    ];

    for (const opts of cases) {
      const { useCase, spies } = build(opts);

      expect(await statusOf(useCase.execute('u1'))).toBe(503);
      expect(spies.markCompleted).not.toHaveBeenCalled();
    }
  });

  it('replays the order as it now reads when its saga has already closed', async () => {
    const { useCase, spies } = build({
      existing: savedOrder(OrderStatus.RESERVING),
      outcome: new CheckoutSagaClosedError('order-1'),
      reread: savedOrder(OrderStatus.PENDING),
    });

    const view = await useCase.execute('u1');

    expect(view).toMatchObject({ id: 'order-1', status: OrderStatus.PENDING });
    expect(spies.findById).toHaveBeenCalledExactlyOnceWith('order-1');
    expect(spies.markCompleted).toHaveBeenCalledOnce();
  });

  it('lets an unexpected engine fault through', async () => {
    const boom = new Error('boom');
    const { useCase } = build({ outcome: boom });

    await expect(useCase.execute('u1')).rejects.toBe(boom);
  });
});
