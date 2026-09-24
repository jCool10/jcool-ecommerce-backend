import type { ConfigService } from '@nestjs/config';
import type { SchedulerRegistry } from '@nestjs/schedule';
import type { ClsService } from 'nestjs-cls';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import type { SweepExpiredReservationsUseCase, SweepSummary } from '../application/use-cases';
import { ReservationTtlScheduler } from './reservation-ttl.scheduler';

const CONFIG: Record<string, unknown> = {
  'reservationSweep.enabled': true,
  'reservationSweep.intervalMs': 60_000,
  'reservationSweep.graceSec': 900,
  'reservationSweep.batchSize': 50,
  'inventory.reservationTtl': '15m',
  'reconcile.orderTtlSec': 900,
  'reconcile.enabled': true,
};

const IDLE: SweepSummary = { scanned: 0, expired: 0, raced: 0, errors: 0 };

function build(overrides: Record<string, unknown> = {}, execute = vi.fn().mockResolvedValue(IDLE)) {
  // Records every key read, so a test can show what the scheduler never looked at.
  const reads: string[] = [];
  const answers = fakeConfigService({ ...CONFIG, ...overrides });
  const config = {
    get: (key: string) => {
      reads.push(key);
      return answers.get<unknown>(key);
    },
    getOrThrow: (key: string) => {
      reads.push(key);
      return answers.getOrThrow<unknown>(key);
    },
  } as unknown as ConfigService;
  const registry = { addInterval: vi.fn(), deleteInterval: vi.fn(), doesExist: vi.fn().mockReturnValue(true) };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const make = () =>
    new ReservationTtlScheduler(
      { execute } as unknown as SweepExpiredReservationsUseCase,
      config,
      registry as unknown as SchedulerRegistry,
      { run: (fn: () => unknown) => fn(), set: vi.fn() } as unknown as ClsService,
      fakePinoLogger(logger),
    );
  return { make, registry, logger, execute, reads };
}

describe('ReservationTtlScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('construction', () => {
    // An undefined interval fires every event-loop turn, a busy loop opening transactions.
    it('refuses to build on a missing or out-of-range setting, even while disabled', () => {
      const invalid: Array<Record<string, unknown>> = [
        { 'reservationSweep.intervalMs': undefined },
        { 'reservationSweep.batchSize': undefined },
        { 'reservationSweep.graceSec': undefined },
        { 'reservationSweep.intervalMs': 0 },
        { 'reservationSweep.enabled': false, 'reservationSweep.batchSize': -1 },
      ];

      for (const overrides of invalid) {
        expect(() => build(overrides).make(), JSON.stringify(overrides)).toThrow(/Invalid reservation sweep config/);
      }
    });
  });

  describe('onModuleInit', () => {
    it('drives a sweep once the period elapses', async () => {
      const { make, registry, execute } = build();

      make().onModuleInit();
      await vi.advanceTimersByTimeAsync(60_000);

      expect(registry.addInterval).toHaveBeenCalledWith('order-reservation-ttl-sweep', expect.anything());
      expect(execute).toHaveBeenCalledWith({ graceSec: 900, batchSize: 50 });
    });

    it('registers nothing at all when disabled', () => {
      const { make, registry } = build({ 'reservationSweep.enabled': false });

      make().onModuleInit();

      expect(registry.addInterval).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });

    // Only reconcile can close a checkout session, so this sweep must never reach an order first.
    it('starts only when the hold TTL plus grace keeps it behind reconcile', () => {
      const shortTtl = { 'inventory.reservationTtl': '60s' };

      expect(() =>
        build({ ...shortTtl, 'reservationSweep.graceSec': 0 })
          .make()
          .onModuleInit(),
      ).toThrow(/before reconcile can close their checkout sessions/);
      const { make, registry } = build({ ...shortTtl, 'reservationSweep.graceSec': 900 });
      make().onModuleInit();
      expect(registry.addInterval).toHaveBeenCalled();
    });

    // Known gap: with both sweeps off nothing releases an unpaid hold and nothing says so, because this
    // branch never reads reconcile.enabled. This test fails once boot refuses that combination.
    it('goes quiet when reconcile is disabled too, leaving nothing to release a hold', () => {
      const { make, registry, logger, reads } = build({
        'reservationSweep.enabled': false,
        'reconcile.enabled': false,
      });

      make().onModuleInit();

      expect(registry.addInterval).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      expect(logger.error).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
      expect(reads).not.toContain('reconcile.enabled');
    });
  });

  describe('tick', () => {
    it('skips a tick while the previous one is still running, so two never scan together', async () => {
      let release = (): void => {};
      const execute = vi.fn().mockReturnValue(new Promise<SweepSummary>((r) => (release = () => r(IDLE))));
      const scheduler = build({}, execute).make();

      const first = scheduler.tick();
      await scheduler.tick();

      expect(execute).toHaveBeenCalledTimes(1);
      release();
      await first;
    });

    // The read is oldest-expiry-first, so holds that cannot be cleared refill every batch after this.
    it('escalates a full batch that expired nothing', async () => {
      const execute = vi.fn().mockResolvedValue({ scanned: 50, expired: 0, raced: 50, errors: 0 });
      const { make, logger } = build({}, execute);

      await make().tick();

      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ stuck: true, raced: 50 }),
        expect.any(String),
      );
    });

    // An unhandled rejection inside a timer callback takes the process down with it.
    it('swallows a sweep that throws and frees the guard for the next tick', async () => {
      const execute = vi.fn().mockRejectedValueOnce(new Error('pool exhausted')).mockResolvedValue(IDLE);
      const { make, logger } = build({}, execute);
      const scheduler = make();

      await expect(scheduler.tick()).resolves.toBeUndefined();
      expect(logger.error).toHaveBeenCalledOnce();

      await scheduler.tick();
      expect(execute).toHaveBeenCalledTimes(2);
    });
  });
});
