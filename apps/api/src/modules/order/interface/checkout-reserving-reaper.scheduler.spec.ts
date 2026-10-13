import type { SchedulerRegistry } from '@nestjs/schedule';
import type { ClsService } from 'nestjs-cls';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { Order } from '../domain/order.entity';
import { OrderItem } from '../domain/order-item.entity';
import { OrderStatus } from '../domain/order-status';
import {
  CheckoutEngineUnavailableError,
  type CheckoutSagaEnginePort,
} from '../application/ports/checkout-saga-engine.port';
import type { OrderRepositoryPort } from '../application/ports/order-repository.port';
import { checkoutSagaSettings } from '../testing/checkout-saga-settings.double';
import { CheckoutReservingReaperScheduler } from './checkout-reserving-reaper.scheduler';

const NOW = new Date('2026-03-01T09:10:00.000Z');
const settings = checkoutSagaSettings({ reservingOrphanMs: 60_000, holdSafetyMs: 3_600_000 });
const CONFIG = { 'checkout.reaperEnabled': true, 'checkout.reaperIntervalMs': 60_000 };

const reserving = (id: string): Order =>
  Order.rehydrate({
    id,
    userId: 'u1',
    status: OrderStatus.RESERVING,
    currency: 'VND',
    items: [OrderItem.of('sku-1', 'Widget', 100_000, 1)],
    totalAmountMinor: 100_000,
    placedAt: new Date('2026-03-01T09:00:00.000Z'),
    paymentDeadlineAt: new Date('2026-03-01T10:00:00.000Z'),
  });

function build(orphans: Order[] = [reserving('o1'), reserving('o2')], overrides: Record<string, unknown> = {}) {
  const orders = {
    findReservingPlacedBefore: vi.fn<OrderRepositoryPort['findReservingPlacedBefore']>(() => Promise.resolve(orphans)),
  };
  const engine = { ensureStarted: vi.fn<CheckoutSagaEnginePort['ensureStarted']>(() => Promise.resolve()) };
  const registry = { addInterval: vi.fn(), deleteInterval: vi.fn(), doesExist: vi.fn().mockReturnValue(true) };
  const logError = vi.fn();
  const scheduler = new CheckoutReservingReaperScheduler(
    orders as unknown as OrderRepositoryPort,
    engine as unknown as CheckoutSagaEnginePort,
    settings,
    fakeConfigService({ ...CONFIG, ...overrides }),
    registry as unknown as SchedulerRegistry,
    { run: (fn: () => unknown) => fn(), set: vi.fn() } as unknown as ClsService,
    fakePinoLogger({ error: logError }),
  );
  return { scheduler, orders, engine, registry, logError };
}

describe('CheckoutReservingReaperScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts the saga of each reserving order older than the orphan age', async () => {
    const { scheduler, orders, engine } = build();

    await scheduler.tick();

    expect(orders.findReservingPlacedBefore).toHaveBeenCalledExactlyOnceWith(
      new Date(NOW.getTime() - settings.reservingOrphanMs),
      50,
    );
    expect(engine.ensureStarted.mock.calls.map(([start]) => start)).toEqual([
      expect.objectContaining({ orderId: 'o1', idempotency: undefined }),
      expect.objectContaining({ orderId: 'o2', idempotency: undefined }),
    ]);
    expect(engine.ensureStarted.mock.calls[0][0].holdUntil).toEqual(new Date('2026-03-01T11:00:00.000Z'));
  });

  it('moves on to the next order when one cannot be started', async () => {
    const { scheduler, engine, logError } = build();
    engine.ensureStarted.mockRejectedValueOnce(new Error('bad order'));

    await scheduler.tick();

    expect(engine.ensureStarted).toHaveBeenCalledTimes(2);
    expect(logError).toHaveBeenCalledWith(expect.objectContaining({ orderId: 'o1' }), expect.any(String));
  });

  it('leaves the rest of the batch for the next tick once Temporal does not answer', async () => {
    const { scheduler, engine } = build();
    engine.ensureStarted.mockRejectedValueOnce(new CheckoutEngineUnavailableError('ensureStarted'));

    await scheduler.tick();

    expect(engine.ensureStarted).toHaveBeenCalledTimes(1);
  });

  it('skips a tick while the previous one still runs', async () => {
    const { scheduler, orders } = build();
    let release!: (orders: Order[]) => void;
    orders.findReservingPlacedBefore.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));

    const first = scheduler.tick();
    await scheduler.tick();
    release([]);
    await first;

    expect(orders.findReservingPlacedBefore).toHaveBeenCalledOnce();
  });

  it('survives a tick that fails as a whole', async () => {
    const { scheduler, orders, logError } = build();
    orders.findReservingPlacedBefore.mockRejectedValueOnce(new Error('db down'));

    await expect(scheduler.tick()).resolves.toBeUndefined();
    expect(logError).toHaveBeenCalledOnce();
  });

  it('runs on its interval and stops with the module', async () => {
    const { scheduler, orders, registry } = build([]);

    scheduler.onModuleInit();
    await vi.advanceTimersByTimeAsync(60_000);
    await scheduler.onModuleDestroy();

    expect(registry.addInterval).toHaveBeenCalledWith('order-checkout-reserving-reaper', expect.anything());
    expect(orders.findReservingPlacedBefore).toHaveBeenCalledOnce();
    expect(registry.deleteInterval).toHaveBeenCalledWith('order-checkout-reserving-reaper');
  });

  it('registers nothing when disabled', () => {
    const { scheduler, registry } = build([], { 'checkout.reaperEnabled': false });

    scheduler.onModuleInit();

    expect(registry.addInterval).not.toHaveBeenCalled();
  });
});
