import { BadRequestException, ConflictException, InternalServerErrorException } from '@nestjs/common';
import type { ClsService } from 'nestjs-cls';
import { describe, expect, it, vi } from 'vitest';
import { StockReservationError } from '@modules/inventory/application/public/stock-reservation.port';
import type { MetricsPort } from '@shared/observability/metrics/metrics.port';
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

function build(
  opts: { lines?: OrderCartLine[]; view?: OrderSkuView | null; checkout?: Checkout; noContext?: boolean } = {},
) {
  // Standalone spies so assertions target plain Mocks, not object members (avoids unbound-method).
  const createCheckout = vi.fn(opts.checkout);
  const findForUser = vi.fn();
  const getLines = vi.fn().mockResolvedValue(opts.lines ?? [{ skuId: SKU, quantity: 2 }]);
  const getSkuView = vi.fn().mockResolvedValue(opts.view === undefined ? skuView() : opts.view);
  const reserve = vi.fn().mockResolvedValue(undefined);
  const commit = vi.fn().mockResolvedValue({ applied: true, alreadyResolved: false, count: 1 });
  const release = vi.fn().mockResolvedValue({ applied: true, alreadyResolved: false, count: 1 });
  const markCompleted = vi.fn().mockResolvedValue(undefined);
  const append = vi.fn().mockResolvedValue(undefined);
  const recordOrderCreated = vi.fn();
  const observeOrderValue = vi.fn();

  const repo = { createCheckout, findForUser, findAllForUser: vi.fn() } as unknown as OrderRepositoryPort;
  const cart: CartSnapshotReaderPort = { getLines };
  const catalog: CatalogQueryPort = { getSkuView };
  const reservation: InventoryReservationPort = { reserve, commit, release, findExpiredHolds: vi.fn() };
  const store = { markCompleted } as unknown as IdempotencyStorePort;
  const outbox: OutboxWriterPort = { append };
  const metrics = { recordOrderCreated, observeOrderValue } as unknown as MetricsPort;
  // noContext models CLS inactive at the use-case boundary (the wired route always has it active).
  const cls = {
    isActive: () => !opts.noContext,
    get: () => ({ scope: SCOPE, key: KEY }),
  } as unknown as ClsService;

  const useCase = new CheckoutOrderUseCase(repo, cart, catalog, reservation, store, outbox, metrics, cls);
  return {
    useCase,
    spies: { createCheckout, findForUser, reserve, markCompleted, append, recordOrderCreated, observeOrderValue },
  };
}

describe('CheckoutOrderUseCase', () => {
  it('rejects an empty cart with 400 and never opens the checkout', async () => {
    const { useCase, spies } = build({ lines: [] });

    await expect(useCase.execute('u1')).rejects.toBeInstanceOf(BadRequestException);
    expect(spies.createCheckout).not.toHaveBeenCalled();
  });

  it('rejects an archived SKU with 400', async () => {
    const { useCase, spies } = build({ view: skuView({ isActive: false }) });

    await expect(useCase.execute('u1')).rejects.toBeInstanceOf(BadRequestException);
    expect(spies.createCheckout).not.toHaveBeenCalled();
  });

  it('checks out: reserves stock, appends the event and completes the key inside the tx, returns the PENDING view, records metrics', async () => {
    const { useCase, spies } = build({
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
    expect(view.placedAt).toEqual(expect.any(String));
    // Reserve ran inside the tx with the freshly-assigned order id.
    expect(spies.reserve).toHaveBeenCalledWith(TX, 'order-1', [{ skuId: SKU, quantity: 2 }]);
    // OrderPlaced appended in the SAME tx, carrying the id the INSERT just assigned.
    const [tx, record] = spies.append.mock.calls[0] as [DrizzleTx, OutboxRecord];
    expect(tx).toBe(TX);
    expect(record).toMatchObject({ aggregateType: 'Order', aggregateId: 'order-1', eventType: 'order.placed' });
    expect(record.payload).toMatchObject({
      orderId: 'order-1',
      userId: 'u1',
      totalAmountMinor: 200_000,
      currency: 'VND',
    });
    expect(typeof record.payload.placedAt).toBe('string');
    // COMPLETED written in the SAME tx (second arg) — the cached responseBody is the returned view.
    expect(spies.markCompleted).toHaveBeenCalledWith(
      expect.objectContaining({ scope: SCOPE, key: KEY, responseStatus: 201, orderId: 'order-1', responseBody: view }),
      TX,
    );
    expect(spies.recordOrderCreated).toHaveBeenCalledWith(OrderStatus.PENDING);
    expect(spies.observeOrderValue).toHaveBeenCalledWith(200_000);
  });

  it('fails loud (500) when the idempotency context is missing, never opening the checkout', async () => {
    // POST /orders is always behind the guard+interceptor; a missing CLS context is a broken wiring
    // contract, not a client error — proceeding would strand an un-completable key.
    const { useCase, spies } = build({ noContext: true });

    await expect(useCase.execute('u1')).rejects.toBeInstanceOf(InternalServerErrorException);
    expect(spies.createCheckout).not.toHaveBeenCalled();
  });

  it('maps a stock shortfall to 409 and records no order (tx rolled back)', async () => {
    // reserve throws the published inventory error inside the tx → the whole tx (order, hold, key)
    // rolls back, so createCheckout rejects.
    const { useCase, spies } = build({
      checkout: () => Promise.reject(new StockReservationError('Insufficient stock', 'OUT_OF_STOCK')),
    });

    await expect(useCase.execute('u1')).rejects.toBeInstanceOf(ConflictException);
    expect(spies.recordOrderCreated).not.toHaveBeenCalled();
  });

  it('heals a crash-reclaim: returns the existing order and points the key at it, no second reserve', async () => {
    const existing = Order.rehydrate({
      id: 'order-existing',
      userId: 'u1',
      status: OrderStatus.PENDING,
      currency: 'VND',
      items: [OrderItem.of(SKU, 'Widget', 100_000, 2)],
      totalAmountMinor: 200_000,
      placedAt: new Date('2026-08-18T00:00:00.000Z'),
    });
    const { useCase, spies } = build({
      checkout: () => Promise.resolve({ orderId: 'order-existing', created: false }),
    });
    spies.findForUser.mockResolvedValue(existing);

    const view = await useCase.execute('u1');

    expect(view).toMatchObject({ id: 'order-existing', status: OrderStatus.PENDING });
    // No fresh hold and no second event; the existing order already reserved and emitted when it
    // was first placed.
    expect(spies.reserve).not.toHaveBeenCalled();
    expect(spies.append).not.toHaveBeenCalled();
    // Key healed to the existing order — a standalone write (single arg, no tx) so replay points at it.
    expect(spies.markCompleted).toHaveBeenCalledWith(
      expect.objectContaining({ scope: SCOPE, key: KEY, orderId: 'order-existing' }),
    );
    expect(spies.recordOrderCreated).not.toHaveBeenCalled();
  });
});
