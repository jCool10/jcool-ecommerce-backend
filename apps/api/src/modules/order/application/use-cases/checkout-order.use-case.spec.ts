import { ConflictException, HttpException, InternalServerErrorException } from '@nestjs/common';
import type { ClsService } from 'nestjs-cls';
import { describe, expect, it, vi } from 'vitest';
import { fakeMetricsPort } from '@jcool/testing/fake-metrics-port';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { StockReservationError } from '@modules/inventory/application/public/stock-reservation.port';
import type { OutboxRecord, OutboxWriterPort } from '@shared/messaging/outbox/outbox-writer.port';
import type { DrizzleTx } from '@shared/infrastructure/database/drizzle.tokens';
import { Order } from '../../domain/order.entity';
import { OrderItem } from '../../domain/order-item.entity';
import { OrderStatus } from '../../domain/order-status';
import type { CartSnapshotReaderPort, OrderCartLine } from '../ports/cart-snapshot.port';
import type { CatalogQueryPort, OrderSkuView } from '../ports/catalog-query.port';
import type { InventoryReservationPort } from '../ports/inventory-reservation.port';
import type { IdempotencyStorePort } from '../ports/idempotency-store.port';
import type { CheckoutPersistResult, OrderRepositoryPort } from '../ports/order-repository.port';
import { CheckoutOrderUseCase } from './checkout-order.use-case';

const SKU = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_SKU = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SCOPE = 'user:u1';
const KEY = '9f8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const TX = {} as DrizzleTx;

type Checkout = (
  order: Order,
  key: string | null,
  reserve: (tx: DrizzleTx, orderId: string) => Promise<void>,
  appendEvent: (tx: DrizzleTx, orderId: string) => Promise<void>,
  complete: (tx: DrizzleTx, orderId: string) => Promise<void>,
) => Promise<CheckoutPersistResult>;

function skuView(overrides: Partial<OrderSkuView> = {}): OrderSkuView {
  return { skuId: SKU, productName: 'Widget', unitPriceMinor: 100_000, currency: 'VND', isActive: true, ...overrides };
}

const TWO_LINES: OrderCartLine[] = [
  { skuId: SKU, quantity: 1 },
  { skuId: OTHER_SKU, quantity: 1 },
];

function build(
  opts: {
    lines?: OrderCartLine[];
    /** The whole batch result verbatim; a SKU absent from it is one Catalog no longer knows. */
    views?: OrderSkuView[];
    checkout?: Checkout;
    noContext?: boolean;
  } = {},
) {
  const createCheckout = vi.fn(opts.checkout);
  const findForUser = vi.fn();
  const getLines = vi.fn().mockResolvedValue(opts.lines ?? [{ skuId: SKU, quantity: 2 }]);
  const getSkuViews = vi.fn().mockResolvedValue(opts.views ?? [skuView()]);
  const reserve = vi.fn().mockResolvedValue(undefined);
  const markCompleted = vi.fn().mockResolvedValue(undefined);
  const append = vi.fn().mockResolvedValue(undefined);
  const metrics = fakeMetricsPort();

  const repo = { createCheckout, findForUser } as unknown as OrderRepositoryPort;
  const cart: CartSnapshotReaderPort = { getLines };
  const catalog: CatalogQueryPort = { getSkuViews };
  const reservation: InventoryReservationPort = {
    reserve,
    commit: vi.fn(),
    release: vi.fn(),
    findExpiredHolds: vi.fn(),
  };
  const store = { markCompleted } as unknown as IdempotencyStorePort;
  const outbox: OutboxWriterPort = { append };
  const cls = {
    isActive: () => !opts.noContext,
    get: () => ({ scope: SCOPE, key: KEY }),
  } as unknown as ClsService;

  const useCase = new CheckoutOrderUseCase(
    repo,
    cart,
    catalog,
    reservation,
    store,
    outbox,
    metrics,
    cls,
    fakePinoLogger(),
  );
  return { useCase, spies: { createCheckout, findForUser, reserve, markCompleted, append }, metrics };
}

describe('CheckoutOrderUseCase', () => {
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
        const { useCase, spies } = build(opts);
        const status = await useCase.execute('u1').then(
          () => 'resolved',
          (error: unknown) => (error instanceof HttpException ? error.getStatus() : error),
        );
        return [label, status, spies.createCheckout.mock.calls.length];
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
      checkout: () => Promise.resolve({ orderId: 'order-1', created: true }),
    });

    const view = await useCase.execute('u1');

    expect(view.totalAmountMinor).toBe(100_000 * 1 + 50_000 * 2);
    expect(view.items).toEqual([
      expect.objectContaining({ skuId: SKU, productName: 'Widget', unitPriceMinor: 100_000, quantity: 1 }),
      expect.objectContaining({ skuId: OTHER_SKU, productName: 'Gadget', unitPriceMinor: 50_000, quantity: 2 }),
    ]);
  });

  it('reserves, emits order.placed and completes the key in one transaction', async () => {
    const { useCase, spies, metrics } = build({
      checkout: async (_order, _key, reserve, appendEvent, complete) => {
        await reserve(TX, 'order-1');
        await appendEvent(TX, 'order-1');
        await complete(TX, 'order-1');
        return { orderId: 'order-1', created: true };
      },
    });

    const view = await useCase.execute('u1');

    expect(view).toMatchObject({
      id: 'order-1',
      status: OrderStatus.PENDING,
      currency: 'VND',
      totalAmountMinor: 200_000,
    });
    expect(spies.reserve).toHaveBeenCalledExactlyOnceWith(TX, 'order-1', [{ skuId: SKU, quantity: 2 }]);
    const [tx, record] = spies.append.mock.calls[0] as [DrizzleTx, OutboxRecord];
    expect(tx).toBe(TX);
    expect(record).toMatchObject({
      aggregateType: 'Order',
      aggregateId: 'order-1',
      eventType: 'order.placed',
      payload: {
        orderId: 'order-1',
        userId: 'u1',
        totalAmountMinor: 200_000,
        currency: 'VND',
        placedAt: view.placedAt,
      },
    });
    // The cached replay must be byte-identical to the first response.
    expect(spies.markCompleted).toHaveBeenCalledExactlyOnceWith(
      { scope: SCOPE, key: KEY, responseStatus: 201, orderId: 'order-1', responseBody: view },
      TX,
    );
    expect(metrics.recordOrderCreated).toHaveBeenCalledExactlyOnceWith(OrderStatus.PENDING);
    expect(metrics.observeOrderValue).toHaveBeenCalledExactlyOnceWith(200_000);
  });

  it('fails loud (500) when the idempotency context is missing, never opening the checkout', async () => {
    const { useCase, spies } = build({ noContext: true });

    await expect(useCase.execute('u1')).rejects.toBeInstanceOf(InternalServerErrorException);
    expect(spies.createCheckout).not.toHaveBeenCalled();
  });

  it('answers a stock shortfall with 409 and counts the reserve step as failed', async () => {
    const { useCase, metrics } = build({
      checkout: () => Promise.reject(new StockReservationError('Insufficient stock', 'OUT_OF_STOCK')),
    });

    await expect(useCase.execute('u1')).rejects.toBeInstanceOf(ConflictException);
    expect(metrics.recordOrderCreated).not.toHaveBeenCalled();
    expect(metrics.recordSagaStep).toHaveBeenCalledExactlyOnceWith('reserve', 'failed');
  });

  it('replays the order a reclaimed key already placed, without a second reserve', async () => {
    const existing = Order.rehydrate({
      id: 'order-existing',
      userId: 'u1',
      status: OrderStatus.PENDING,
      currency: 'VND',
      items: [OrderItem.of(SKU, 'Widget', 100_000, 2)],
      totalAmountMinor: 200_000,
      placedAt: new Date('2026-08-18T00:00:00.000Z'),
    });
    const { useCase, spies, metrics } = build({
      checkout: () => Promise.resolve({ orderId: 'order-existing', created: false }),
    });
    spies.findForUser.mockResolvedValue(existing);

    const view = await useCase.execute('u1');

    expect(view).toMatchObject({ id: 'order-existing', status: OrderStatus.PENDING });
    expect(spies.reserve).not.toHaveBeenCalled();
    expect(spies.append).not.toHaveBeenCalled();
    // No tx argument: the checkout transaction never opened, so the heal writes on its own.
    expect(spies.markCompleted).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ scope: SCOPE, key: KEY, orderId: 'order-existing', responseBody: view }),
    );
    expect(metrics.recordOrderCreated).not.toHaveBeenCalled();
    expect(metrics.recordSagaStep).not.toHaveBeenCalled();
  });
});
