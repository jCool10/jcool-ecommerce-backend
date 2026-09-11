import type { ConfigService } from '@nestjs/config';
import type { SchedulerRegistry } from '@nestjs/schedule';
import type { ClsService } from 'nestjs-cls';
import type { PinoLogger } from 'nestjs-pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeConfigService } from '@shared/testing/fake-config.service';
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
  // The rest of reconcile's configuration, present so a test can ask whether it is ever consulted.
  'reconcile.enabled': true,
  'reconcile.intervalMs': 60_000,
  'reconcile.batchSize': 50,
};

const IDLE: SweepSummary = { scanned: 0, expired: 0, raced: 0, errors: 0 };

function build(overrides: Record<string, unknown> = {}, execute = vi.fn().mockResolvedValue(IDLE)) {
  // Every key the scheduler asks for, in order — so a test can assert not only what it decided but
  // what it looked at to decide. Answers come from the shared fake, so "absent key throws" stays
  // defined in exactly one place; this only records the question on the way through.
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

    // CHARACTERIZATION — pins today's behaviour, which is NOT the intended one.
    //
    // Intended invariant: starting this sweep means reconcile genuinely reaches an order first, so
    //   the checkout session is closed before the stock hold is released.
    // Violated at: src/modules/order/interface/reservation-ttl.scheduler.ts:109 —
    //   `assertBehindReconcile` compares thresholds and nothing else. Reconcile's cadence decides
    //   whether it can reach an order inside the TTL at all, and a tick slower than the TTL means it
    //   never does; the assert reads neither that key nor `reconcile.enabled`, so the ordering it
    //   claims to enforce holds only for the default cadence nobody re-checks after changing it.
    // Follow-up: plans/260910-1940-edge-case-invariant-fixes/plan.md — SAGA-1 (and matrix q2:
    //   whether cadence and batch drain belong in this assert or in a separate readiness check).
    it('starts even when reconcile ticks an hour apart on orders that expire in fifteen minutes', () => {
      const { make, registry, reads } = build({ 'reconcile.intervalMs': 3_600_000 });

      expect(() => make().onModuleInit()).not.toThrow();

      expect(registry.addInterval).toHaveBeenCalled();
      // The reason it cannot object: it never looked.
      expect(reads).toContain('reconcile.orderTtlSec');
      expect(reads).not.toContain('reconcile.intervalMs');
      expect(reads).not.toContain('reconcile.batchSize');
    });

    // CHARACTERIZATION — pins today's behaviour, which is NOT the intended one.
    //
    // Intended invariant: some sweep is always responsible for releasing a stock hold nobody paid
    //   for; turning both off is a misconfiguration, not a mode.
    // Violated at: src/modules/order/interface/reservation-ttl.scheduler.ts:48-51 — the disabled
    //   branch logs at INFO and returns without ever reading `reconcile.enabled`, and reconcile's own
    //   scheduler does the same in mirror image. With both off nothing releases a hold and nothing
    //   says so: every order that goes unpaid holds its stock until a human notices the shelf is
    //   empty. Contrast src/shared/messaging/inbox/sweep-inbox.ts:52, which refuses to boot on
    //   exactly this shape of cross-config hazard.
    // Follow-up: plans/260910-1940-edge-case-invariant-fixes/plan.md — SAGA-3.
    it('goes quiet when reconcile is disabled too, leaving nothing to release a hold', () => {
      const { make, registry, logger, reads } = build({
        'reservationSweep.enabled': false,
        'reconcile.enabled': false,
      });

      make().onModuleInit();

      expect(registry.addInterval).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      // INFO, the same line a deliberate single-sweep deployment writes — nothing distinguishes the
      // configuration where stock is never released from the one where it still is.
      expect(logger.info).toHaveBeenCalledWith(expect.anything(), 'reservation expiry sweep disabled');
      expect(logger.error).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
      expect(reads).not.toContain('reconcile.enabled');
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
