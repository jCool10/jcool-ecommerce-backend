import type { ConfigService } from '@nestjs/config';
import type { SchedulerRegistry } from '@nestjs/schedule';
import type { ClsService } from 'nestjs-cls';
import type { PinoLogger } from 'nestjs-pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SweepExpiredReservationsUseCase, SweepSummary } from '../application/use-cases';
import { ReservationTtlScheduler } from './reservation-ttl.scheduler';

const CONFIG: Record<string, unknown> = {
  'reservationSweep.enabled': true,
  'reservationSweep.intervalMs': 60_000,
  'reservationSweep.graceSec': 900,
  'reservationSweep.batchSize': 50,
  // Not this scheduler's keys, but its ordering guarantee is defined against them.
  'inventory.reservationTtl': '15m',
  'reconcile.orderTtlSec': 900,
};

const IDLE: SweepSummary = { scanned: 0, expired: 0, raced: 0, errors: 0 };

function build(overrides: Record<string, unknown> = {}, execute = vi.fn().mockResolvedValue(IDLE)) {
  const values = { ...CONFIG, ...overrides };
  const config = {
    get: (key: string) => values[key],
    getOrThrow: (key: string) => {
      if (values[key] === undefined) throw new Error(`Missing config key: ${key}`);
      return values[key];
    },
  } as unknown as ConfigService;
  const registry = {
    addInterval: vi.fn(),
    deleteInterval: vi.fn(),
    doesExist: vi.fn().mockReturnValue(true),
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const make = () =>
    new ReservationTtlScheduler(
      { execute } as unknown as SweepExpiredReservationsUseCase,
      config,
      registry as unknown as SchedulerRegistry,
      // Pass-through: correlation is asserted in job-context.spec.ts, and a real CLS scope here
      // would only add a layer between the test and the tick it is driving.
      { run: (fn: () => unknown) => fn(), set: vi.fn() } as unknown as ClsService,
      logger as unknown as PinoLogger,
    );
  return { make, registry, logger, execute };
}

describe('ReservationTtlScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('construction', () => {
    it.each(['reservationSweep.intervalMs', 'reservationSweep.batchSize', 'reservationSweep.graceSec'])(
      'refuses to build when %s is missing, rather than scheduling an undefined interval',
      (key) => {
        expect(() => build({ [key]: undefined }).make()).toThrow(/Invalid reservation sweep config/);
      },
    );

    it('refuses a zero interval, which would busy-loop opening transactions', () => {
      expect(() => build({ 'reservationSweep.intervalMs': 0 }).make()).toThrow(/Invalid reservation sweep config/);
    });

    it('validates config even while disabled, so a typo surfaces at boot and not on first enable', () => {
      expect(() => build({ 'reservationSweep.enabled': false, 'reservationSweep.batchSize': -1 }).make()).toThrow(
        /Invalid reservation sweep config/,
      );
    });
  });

  describe('onModuleInit', () => {
    it('drives a sweep once the period elapses', async () => {
      const { make, registry, execute } = build();

      const scheduler = make();
      scheduler.onModuleInit();
      await vi.advanceTimersByTimeAsync(60_000);

      expect(registry.addInterval).toHaveBeenCalledWith('order-reservation-ttl-sweep', expect.anything());
      expect(execute).toHaveBeenCalledWith({ graceSec: 900, batchSize: 50 });
      scheduler.onModuleDestroy();
    });

    it('registers nothing at all when disabled', () => {
      const { make, registry, logger } = build({ 'reservationSweep.enabled': false });

      make().onModuleInit();

      expect(registry.addInterval).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      expect(logger.info).toHaveBeenCalledWith(expect.anything(), 'reservation expiry sweep disabled');
    });

    // This sweep cannot close a checkout session; reconcile can. Shortening the hold TTL moves this
    // one ahead of reconcile, silently disabling that safeguard, so it has to fail at boot instead.
    it('refuses to start when a shortened hold TTL would put it ahead of reconcile', () => {
      const { make } = build({ 'inventory.reservationTtl': '60s', 'reservationSweep.graceSec': 0 });

      expect(() => make().onModuleInit()).toThrow(/before reconcile can close their checkout sessions/);
    });

    it('starts when the grace keeps it behind reconcile even on a short hold TTL', () => {
      const { make, registry } = build({ 'inventory.reservationTtl': '60s', 'reservationSweep.graceSec': 900 });

      make().onModuleInit();

      expect(registry.addInterval).toHaveBeenCalled();
    });

    // e2e drives the use case directly with no grace; the timer never starts, so neither does this.
    it('does not check the ordering when the sweep is disabled', () => {
      const { make } = build({
        'reservationSweep.enabled': false,
        'reservationSweep.graceSec': 0,
        'inventory.reservationTtl': '60s',
      });

      expect(() => make().onModuleInit()).not.toThrow();
    });
  });

  describe('tick', () => {
    it('skips a tick while the previous one is still running, so two never scan together', async () => {
      let release = (): void => {};
      const execute = vi.fn().mockReturnValue(new Promise<SweepSummary>((r) => (release = () => r(IDLE))));
      const { make, logger } = build({}, execute);

      const scheduler = make();
      const first = scheduler.tick();
      await scheduler.tick();

      expect(execute).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('tick skipped'));
      release();
      await first;
    });

    it('logs a tick that did work and stays quiet on an idle one', async () => {
      const execute = vi.fn().mockResolvedValueOnce({ scanned: 3, expired: 3, raced: 0, errors: 0 });
      const { make, logger } = build({}, execute);
      const scheduler = make();

      await scheduler.tick();
      expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ expired: 3 }), expect.any(String));

      logger.info.mockClear();
      execute.mockResolvedValueOnce(IDLE);
      await scheduler.tick();
      expect(logger.info).not.toHaveBeenCalled();
    });

    // The read is ordered oldest-expiry-first, so holds that cannot be cleared refill the batch
    // every tick and nothing behind them is ever reached.
    it('escalates a full batch that expired nothing', async () => {
      const execute = vi.fn().mockResolvedValue({ scanned: 50, expired: 0, raced: 50, errors: 0 });
      const { make, logger } = build({}, execute);

      await make().tick();

      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ stuck: true, raced: 50 }),
        expect.stringContaining('stock stays held'),
      );
      expect(logger.info).not.toHaveBeenCalled();
    });

    it('stays quiet about a full batch that did expire orders', async () => {
      const execute = vi.fn().mockResolvedValue({ scanned: 50, expired: 49, raced: 1, errors: 0 });
      const { make, logger } = build({}, execute);

      await make().tick();

      expect(logger.error).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ expired: 49 }), expect.any(String));
    });

    // An unhandled rejection inside a timer callback takes the process down with it.
    it('swallows a sweep that throws and frees the guard for the next tick', async () => {
      const execute = vi.fn().mockRejectedValueOnce(new Error('pool exhausted')).mockResolvedValue(IDLE);
      const { make, logger } = build({}, execute);
      const scheduler = make();

      await expect(scheduler.tick()).resolves.toBeUndefined();
      expect(logger.error).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('pool exhausted'));

      await scheduler.tick();
      expect(execute).toHaveBeenCalledTimes(2);
    });
  });

  describe('onModuleDestroy', () => {
    it('clears the interval so no tick outlives the connection pool', () => {
      const { make, registry } = build();

      const scheduler = make();
      scheduler.onModuleInit();
      scheduler.onModuleDestroy();

      expect(registry.deleteInterval).toHaveBeenCalledWith('order-reservation-ttl-sweep');
    });

    it('is safe when no interval was ever registered', () => {
      const { make, registry } = build({ 'reservationSweep.enabled': false });
      registry.doesExist.mockReturnValue(false);

      expect(() => make().onModuleDestroy()).not.toThrow();
      expect(registry.deleteInterval).not.toHaveBeenCalled();
    });
  });
});
