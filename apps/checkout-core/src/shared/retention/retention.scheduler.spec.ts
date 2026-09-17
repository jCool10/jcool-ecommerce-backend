import type { SchedulerRegistry } from '@nestjs/schedule';
import type { ClsService } from 'nestjs-cls';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MetricsPort } from '@shared/observability/metrics/metrics.port';
import { fakeConfigService } from '@shared/testing/fake-config.service';
import { fakePinoLogger } from '@shared/testing/fake-pino-logger';
import type { RetentionSweep } from './retention-sweep.port';
import { RetentionSweepRegistry } from './retention-sweep.registry';
import { RetentionScheduler } from './retention.scheduler';

const CONFIG: Record<string, unknown> = {
  'retention.enabled': true,
  'retention.intervalMs': 3_600_000,
  'retention.batchSize': 500,
  'retention.sweepTimeoutMs': 30_000,
};

const idle = () => vi.fn<RetentionSweep['sweep']>().mockResolvedValue(0);

const stub = (name: string, sweep: RetentionSweep['sweep'] = idle()): RetentionSweep => ({ name, sweep });

function build(overrides: Record<string, unknown> = {}, sweeps: RetentionSweep[] = []) {
  const config = fakeConfigService({ ...CONFIG, ...overrides });
  const registry = new RetentionSweepRegistry();
  for (const sweep of sweeps) registry.register(sweep);

  const schedulerRegistry = {
    addInterval: vi.fn(),
    deleteInterval: vi.fn(),
    doesExist: vi.fn().mockReturnValue(true),
  };
  const metrics = {
    recordRetentionSweep: vi.fn(),
    observeRetentionSweepDuration: vi.fn(),
    recordRetentionSweepFailure: vi.fn(),
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const make = () =>
    new RetentionScheduler(
      registry,
      config,
      schedulerRegistry as unknown as SchedulerRegistry,
      // Pass-through; correlation is asserted in job-context.spec.ts.
      { run: (fn: () => unknown) => fn(), set: vi.fn() } as unknown as ClsService,
      metrics as unknown as MetricsPort,
      fakePinoLogger(logger),
    );
  return { make, registry, schedulerRegistry, metrics, logger };
}

describe('RetentionScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('construction', () => {
    it.each(['retention.intervalMs', 'retention.batchSize', 'retention.sweepTimeoutMs'])(
      'refuses to build when %s is missing, rather than scheduling an undefined interval',
      (key) => {
        expect(() => build({ [key]: undefined }).make()).toThrow(/Invalid retention config/);
      },
    );

    it('refuses a zero interval, which would busy-loop issuing DELETEs', () => {
      expect(() => build({ 'retention.intervalMs': 0 }).make()).toThrow(/Invalid retention config/);
    });

    it('validates config even while disabled, so a typo surfaces at boot and not on first enable', () => {
      expect(() => build({ 'retention.enabled': false, 'retention.batchSize': -1 }).make()).toThrow(
        /Invalid retention config/,
      );
    });
  });

  describe('onApplicationBootstrap', () => {
    it('drives every registered sweep once the period elapses', async () => {
      const outbox = idle();
      const inbox = idle();
      const { make, schedulerRegistry } = build({}, [stub('messaging:outbox', outbox), stub('messaging:inbox', inbox)]);

      const scheduler = make();
      scheduler.onApplicationBootstrap();
      await vi.advanceTimersByTimeAsync(3_600_000);

      expect(schedulerRegistry.addInterval).toHaveBeenCalledWith('shared-retention-sweep', expect.anything());
      expect(outbox).toHaveBeenCalledWith(500);
      expect(inbox).toHaveBeenCalledWith(500);
      scheduler.onModuleDestroy();
    });

    it('registers nothing at all when disabled', () => {
      const { make, schedulerRegistry, logger } = build({ 'retention.enabled': false }, [stub('messaging:outbox')]);

      make().onApplicationBootstrap();

      expect(schedulerRegistry.addInterval).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      expect(logger.info).toHaveBeenCalledWith('retention sweeps disabled');
    });

    it('names the sweeps it will drive, which is where a forgotten registration shows up', () => {
      const { make, logger } = build({}, [stub('messaging:outbox'), stub('order:idempotency-keys')]);

      make().onApplicationBootstrap();

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ sweeps: ['messaging:outbox', 'order:idempotency-keys'] }),
        'retention sweeps scheduled',
      );
    });
  });

  describe('tick', () => {
    it('starts the sweeps together rather than one after another', async () => {
      let running = 0;
      let peak = 0;
      const slow = (): Promise<number> => {
        peak = Math.max(peak, ++running);
        return new Promise((resolve) => setTimeout(() => (running--, resolve(0)), 10));
      };
      const { make } = build({}, [stub('a', slow), stub('b', slow), stub('c', slow)]);

      const tick = make().tick();
      await vi.advanceTimersByTimeAsync(10);
      await tick;

      expect(peak).toBe(3);
    });

    it('records rows and duration per sweep, so the label points at one table', async () => {
      const { make, metrics } = build({}, [
        stub('messaging:outbox', vi.fn().mockResolvedValue(12)),
        stub('messaging:inbox', vi.fn().mockResolvedValue(0)),
      ]);

      await make().tick();

      // The idle sweep is recorded too — a series that only appears once a sweep deletes something
      // cannot be told apart from one that is not running.
      expect(metrics.recordRetentionSweep).toHaveBeenCalledWith('messaging:outbox', 12);
      expect(metrics.recordRetentionSweep).toHaveBeenCalledWith('messaging:inbox', 0);
      expect(metrics.observeRetentionSweepDuration).toHaveBeenCalledWith('messaging:outbox', expect.any(Number));
    });

    it('logs a sweep that did work and stays quiet on an idle one', async () => {
      const { make, logger } = build({}, [
        stub('messaging:outbox', vi.fn().mockResolvedValue(12)),
        stub('messaging:inbox', vi.fn().mockResolvedValue(0)),
      ]);

      await make().tick();

      const completed = logger.info.mock.calls.filter(([, message]) => message === 'retention sweep completed');
      expect(completed).toHaveLength(1);
      expect(completed[0][0]).toMatchObject({ sweep: 'messaging:outbox', deleted: 12 });
    });

    it('warns when a sweep fills its batch', async () => {
      const { make, logger } = build({}, [stub('messaging:outbox', vi.fn().mockResolvedValue(500))]);

      await make().tick();

      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ sweep: 'messaging:outbox', deleted: 500, batchSize: 500 }),
        expect.stringContaining('filled its batch'),
      );
    });

    it('announces the full roster once, not on every tick', async () => {
      const { make, logger } = build({}, [stub('messaging:outbox')]);
      const scheduler = make();

      await scheduler.tick();
      await scheduler.tick();

      const announcements = logger.info.mock.calls.filter(
        ([, message]) => message === 'retention sweeps running for the first time',
      );
      expect(announcements).toHaveLength(1);
      expect(announcements[0][0]).toMatchObject({ sweeps: ['messaging:outbox'], count: 1 });
    });
  });

  describe('fault isolation', () => {
    it('skips only the sweep that is still running, not the whole tick', async () => {
      let release = (): void => {};
      const slow = vi.fn().mockReturnValue(new Promise<number>((resolve) => (release = () => resolve(0))));
      const fast = idle();
      const { make, logger } = build({}, [stub('messaging:outbox', slow), stub('messaging:inbox', fast)]);
      const scheduler = make();

      const first = scheduler.tick();
      // Let the fast sweep finish and release its own guard; only the slow one is still holding.
      await vi.advanceTimersByTimeAsync(0);
      await scheduler.tick();

      expect(slow).toHaveBeenCalledTimes(1);
      expect(fast).toHaveBeenCalledTimes(2);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ sweep: 'messaging:outbox' }),
        expect.stringContaining('still running'),
      );
      release();
      await first;
    });

    it('counts every skipped tick, so a permanently stuck sweep does not go quiet in metrics', async () => {
      const stuck = vi.fn().mockReturnValue(new Promise<number>(() => {}));
      const { make, metrics } = build({}, [stub('messaging:outbox', stuck)]);
      const scheduler = make();

      const first = scheduler.tick();
      await vi.advanceTimersByTimeAsync(30_000);
      await first;
      expect(metrics.recordRetentionSweepFailure).toHaveBeenCalledTimes(1);

      await scheduler.tick();
      await scheduler.tick();

      expect(stuck).toHaveBeenCalledTimes(1);
      expect(metrics.recordRetentionSweepFailure).toHaveBeenCalledTimes(3);
    });

    it('survives a sweep that throws synchronously, and still frees it for the next tick', async () => {
      let mode: 'throw' | 'ok' = 'throw';
      const brittle = vi.fn<RetentionSweep['sweep']>().mockImplementation(() => {
        if (mode === 'throw') throw new Error('config read blew up');
        return Promise.resolve(0);
      });
      const healthy = idle();
      const { make, metrics } = build({}, [stub('messaging:outbox', brittle), stub('messaging:inbox', healthy)]);
      const scheduler = make();

      await expect(scheduler.tick()).resolves.toBeUndefined();

      expect(healthy).toHaveBeenCalledTimes(1);
      expect(metrics.recordRetentionSweepFailure).toHaveBeenCalledWith('messaging:outbox');

      // The guard was released, so the next tick tries it again rather than skipping it forever.
      mode = 'ok';
      await scheduler.tick();
      expect(brittle).toHaveBeenCalledTimes(2);
    });

    it('gives up waiting on a sweep past its timeout without taking the tick down', async () => {
      const stuck = vi.fn().mockReturnValue(new Promise<number>(() => {}));
      const { make, metrics, logger } = build({}, [stub('messaging:outbox', stuck)]);

      const tick = make().tick();
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(tick).resolves.toBeUndefined();

      expect(metrics.recordRetentionSweepFailure).toHaveBeenCalledWith('messaging:outbox');
      // The elapsed budget is carried by the error, not the message: the message stays the one
      // string every retention failure groups under.
      expect(logger.error).toHaveBeenCalledWith(
        {
          sweep: 'messaging:outbox',
          err: expect.objectContaining({ message: expect.stringContaining('exceeded 30000ms') as unknown }) as unknown,
        },
        'retention sweep failed',
      );
    });

    // The timeout ends the wait, not the DELETE. Freeing the guard when the wait ends would start a
    // second DELETE against the rows the first one still holds locks on.
    it('holds the guard until the timed-out statement itself finishes', async () => {
      let release = (): void => {};
      const slow = vi.fn().mockReturnValue(new Promise<number>((resolve) => (release = () => resolve(0))));
      const { make } = build({}, [stub('messaging:outbox', slow)]);
      const scheduler = make();

      const first = scheduler.tick();
      await vi.advanceTimersByTimeAsync(30_000);
      await first;

      await scheduler.tick();
      expect(slow).toHaveBeenCalledTimes(1);

      release();
      await vi.advanceTimersByTimeAsync(0);
      await scheduler.tick();
      expect(slow).toHaveBeenCalledTimes(2);
    });
  });

  describe('onModuleDestroy', () => {
    it('clears the interval so no tick outlives the connection pool', () => {
      const { make, schedulerRegistry } = build({}, [stub('messaging:outbox')]);

      const scheduler = make();
      scheduler.onApplicationBootstrap();
      scheduler.onModuleDestroy();

      expect(schedulerRegistry.deleteInterval).toHaveBeenCalledWith('shared-retention-sweep');
    });

    it('is safe when no interval was ever registered', () => {
      const { make, schedulerRegistry } = build({ 'retention.enabled': false });
      schedulerRegistry.doesExist.mockReturnValue(false);

      expect(() => make().onModuleDestroy()).not.toThrow();
      expect(schedulerRegistry.deleteInterval).not.toHaveBeenCalled();
    });
  });
});
