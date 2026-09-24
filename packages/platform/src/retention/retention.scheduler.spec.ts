import { SchedulerRegistry } from '@nestjs/schedule';
import { ClsServiceManager } from 'nestjs-cls';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { fakeMetricsPort } from '@jcool/testing/fake-metrics-port';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
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

  const schedulerRegistry = new SchedulerRegistry();
  const metrics = fakeMetricsPort();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const make = () =>
    new RetentionScheduler(
      registry,
      config,
      schedulerRegistry,
      ClsServiceManager.getClsService(),
      metrics,
      fakePinoLogger(logger),
    );
  return { make, schedulerRegistry, metrics, logger };
}

describe('RetentionScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // An undefined or zero interval makes setInterval fire every event-loop turn.
  it('refuses to build on a missing or non-positive setting, even while disabled', () => {
    const refused = (overrides: Record<string, unknown>): boolean => {
      try {
        build(overrides).make();
        return false;
      } catch (error) {
        return /Invalid retention config/.test((error as Error).message);
      }
    };
    const invalid = [
      { 'retention.intervalMs': undefined },
      { 'retention.batchSize': undefined },
      { 'retention.sweepTimeoutMs': undefined },
      { 'retention.intervalMs': 0 },
      { 'retention.enabled': false, 'retention.batchSize': -1 },
    ];

    expect(invalid.filter((overrides) => !refused(overrides))).toEqual([]);
  });

  describe('onApplicationBootstrap', () => {
    it('drives every registered sweep once the period elapses', async () => {
      const outbox = idle();
      const inbox = idle();
      const { make, schedulerRegistry } = build({}, [stub('messaging:outbox', outbox), stub('messaging:inbox', inbox)]);

      const scheduler = make();
      scheduler.onApplicationBootstrap();
      await vi.advanceTimersByTimeAsync(3_600_000);

      expect(schedulerRegistry.getIntervals()).toEqual(['shared-retention-sweep']);
      expect(outbox).toHaveBeenCalledWith(500);
      expect(inbox).toHaveBeenCalledWith(500);
      scheduler.onModuleDestroy();
    });

    it('registers nothing at all when disabled', () => {
      const { make, schedulerRegistry } = build({ 'retention.enabled': false }, [stub('messaging:outbox')]);

      make().onApplicationBootstrap();

      expect(schedulerRegistry.getIntervals()).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
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

    // An idle sweep is recorded too: a series that only appears once a sweep deletes something
    // cannot be told apart from one that is not running.
    it('records rows and duration per sweep', async () => {
      const { make, metrics } = build({}, [
        stub('messaging:outbox', vi.fn().mockResolvedValue(12)),
        stub('messaging:inbox', vi.fn().mockResolvedValue(0)),
      ]);

      await make().tick();

      expect(metrics.recordRetentionSweep).toHaveBeenCalledWith('messaging:outbox', 12);
      expect(metrics.recordRetentionSweep).toHaveBeenCalledWith('messaging:inbox', 0);
      expect(metrics.observeRetentionSweepDuration).toHaveBeenCalledWith('messaging:outbox', expect.any(Number));
    });

    it('logs deleted rows at info, a full batch at warn, and an idle sweep not at all', async () => {
      const levelsAfter = async (deleted: number): Promise<string[]> => {
        const { make, logger } = build({}, [stub('messaging:outbox', vi.fn().mockResolvedValue(deleted))]);
        const scheduler = make();
        await scheduler.tick();
        // The first tick also announces the roster.
        logger.info.mockClear();
        logger.warn.mockClear();
        await scheduler.tick();
        return [...logger.info.mock.calls.map(() => 'info'), ...logger.warn.mock.calls.map(() => 'warn')];
      };

      expect([await levelsAfter(12), await levelsAfter(500), await levelsAfter(0)]).toEqual([['info'], ['warn'], []]);
    });

    it('announces the full roster once, not on every tick', async () => {
      const { make, logger } = build({}, [stub('messaging:outbox')]);
      const scheduler = make();

      await scheduler.tick();
      await scheduler.tick();

      expect(logger.info).toHaveBeenCalledTimes(1);
      expect(logger.info.mock.calls[0][0]).toEqual({ sweeps: ['messaging:outbox'], count: 1 });
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

    // A sweep stuck for good would otherwise go flat in metrics after its one timeout.
    it('counts every skipped tick as a failure', async () => {
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

  it('clears the interval on shutdown', () => {
    const { make, schedulerRegistry } = build({}, [stub('messaging:outbox')]);

    const scheduler = make();
    scheduler.onApplicationBootstrap();
    scheduler.onModuleDestroy();

    expect(schedulerRegistry.getIntervals()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
