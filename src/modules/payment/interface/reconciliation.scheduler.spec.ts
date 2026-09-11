import type { SchedulerRegistry } from '@nestjs/schedule';
import type { ClsService } from 'nestjs-cls';
import { fakePinoLogger } from '@shared/testing/fake-pino-logger';
import { fakeConfigService } from '@shared/testing/fake-config.service';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReconcileStaleOrdersUseCase, ReconcileSummary } from '../application/use-cases';
import { ReconciliationScheduler } from './reconciliation.scheduler';

const CONFIG: Record<string, unknown> = {
  'reconcile.enabled': true,
  'reconcile.intervalMs': 60_000,
  'reconcile.staleAfterSec': 120,
  'reconcile.orderTtlSec': 900,
  'reconcile.batchSize': 50,
};

const IDLE: ReconcileSummary = {
  scanned: 0,
  finalized: 0,
  stillPending: 0,
  alreadySettled: 0,
  raced: 0,
  unresolved: 0,
  errors: 0,
};

function build(overrides: Record<string, unknown> = {}, execute = vi.fn().mockResolvedValue(IDLE)) {
  const values = { ...CONFIG, ...overrides };
  const config = fakeConfigService(values);
  const registry = {
    addInterval: vi.fn(),
    deleteInterval: vi.fn(),
    doesExist: vi.fn().mockReturnValue(true),
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const make = () =>
    new ReconciliationScheduler(
      { execute } as unknown as ReconcileStaleOrdersUseCase,
      config,
      registry as unknown as SchedulerRegistry,
      // Pass-through: correlation is asserted in job-context.spec.ts.
      { run: (fn: () => unknown) => fn(), set: vi.fn() } as unknown as ClsService,
      fakePinoLogger(logger),
    );
  return { make, registry, logger, execute };
}

describe('ReconciliationScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('construction', () => {
    it.each(['reconcile.intervalMs', 'reconcile.batchSize', 'reconcile.staleAfterSec'])(
      'refuses to build when %s is missing, rather than scheduling an undefined interval',
      (key) => {
        expect(() => build({ [key]: undefined }).make()).toThrow(/Invalid reconciliation config/);
      },
    );

    it('refuses a zero interval, which would busy-loop against the gateway', () => {
      expect(() => build({ 'reconcile.intervalMs': 0 }).make()).toThrow(/Invalid reconciliation config/);
    });

    it('validates config even while disabled, so a typo surfaces at boot and not on first enable', () => {
      expect(() => build({ 'reconcile.enabled': false, 'reconcile.batchSize': -1 }).make()).toThrow(
        /Invalid reconciliation config/,
      );
    });
  });

  describe('onModuleInit', () => {
    it('registers a timer at the configured period', () => {
      const { make, registry } = build();

      const scheduler = make();
      scheduler.onModuleInit();

      expect(registry.addInterval).toHaveBeenCalledWith('payment-reconcile-stale-orders', expect.anything());
      expect(vi.getTimerCount()).toBe(1);
      scheduler.onModuleDestroy();
    });

    it('drives a sweep once the period elapses', async () => {
      const { make, execute } = build();

      const scheduler = make();
      scheduler.onModuleInit();
      await vi.advanceTimersByTimeAsync(60_000);

      expect(execute).toHaveBeenCalledWith({ staleAfterSec: 120, ttlSec: 900, batchSize: 50 });
      scheduler.onModuleDestroy();
    });

    it('registers nothing at all when disabled', () => {
      const { make, registry, logger } = build({ 'reconcile.enabled': false });

      make().onModuleInit();

      expect(registry.addInterval).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      expect(logger.info).toHaveBeenCalledWith(expect.anything(), 'reconciliation sweep disabled');
    });
  });

  describe('onModuleDestroy', () => {
    it('clears the interval so no tick outlives the connection pool', () => {
      const { make, registry } = build();

      const scheduler = make();
      scheduler.onModuleInit();
      scheduler.onModuleDestroy();

      expect(registry.deleteInterval).toHaveBeenCalledWith('payment-reconcile-stale-orders');
    });

    it('is safe when no interval was ever registered', () => {
      const { make, registry } = build({ 'reconcile.enabled': false });
      registry.doesExist.mockReturnValue(false);

      make().onModuleDestroy();

      expect(registry.deleteInterval).not.toHaveBeenCalled();
    });
  });

  describe('tick', () => {
    it('skips a tick while the previous sweep is still working', async () => {
      let release: () => void = () => {};
      const execute = vi.fn(() => new Promise<ReconcileSummary>((resolve) => (release = () => resolve(IDLE))));
      const { make, logger } = build({}, execute);

      const scheduler = make();
      const first = scheduler.tick();
      await scheduler.tick();

      expect(execute).toHaveBeenCalledOnce();
      expect(logger.warn).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('tick skipped'));
      release();
      await first;
    });

    it('resumes after the previous sweep finishes', async () => {
      const { make, execute } = build();

      const scheduler = make();
      await scheduler.tick();
      await scheduler.tick();

      expect(execute).toHaveBeenCalledTimes(2);
    });

    it('swallows a sweep failure — an unhandled rejection in a timer would kill the process', async () => {
      const execute = vi.fn().mockRejectedValue(new Error('orders query failed'));
      const { make, logger } = build({}, execute);

      const scheduler = make();
      await expect(scheduler.tick()).resolves.toBeUndefined();
      expect(logger.error).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('orders query failed'));

      // The guard is released, so the failure costs one tick and not the whole schedule.
      await scheduler.tick();
      expect(execute).toHaveBeenCalledTimes(2);
    });

    it('stays quiet on an idle sweep and logs one line when it touched something', async () => {
      const execute = vi.fn().mockResolvedValue(IDLE);
      const { make, logger } = build({}, execute);
      const scheduler = make();

      await scheduler.tick();
      expect(logger.info).not.toHaveBeenCalled();

      execute.mockResolvedValue({ ...IDLE, scanned: 1, finalized: 1 });
      await scheduler.tick();
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ scanned: 1, finalized: 1 }),
        'reconciliation sweep completed',
      );
    });
  });
});
