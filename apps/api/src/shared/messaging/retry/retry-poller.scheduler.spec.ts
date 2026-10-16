import { SchedulerRegistry } from '@nestjs/schedule';
import type { ClsService } from 'nestjs-cls';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import type { RetryPoller, RetryTickSummary } from './retry-poller';
import { RetryPollerScheduler } from './retry-poller.scheduler';

const CONFIG: Record<string, unknown> = {
  'messaging.retry.enabled': true,
  'queue.workerEnabled': true,
  'messaging.retry.pollMs': 1_000,
  'messaging.retry.batchSize': 50,
};

const IDLE: RetryTickSummary = { leased: 0, processed: 0, rescheduled: 0, buried: 0, lost: 0 };

function build(overrides: Record<string, unknown> = {}, runOnce = vi.fn().mockResolvedValue(IDLE)) {
  const error = vi.fn();
  const registry = new SchedulerRegistry();
  const make = () =>
    new RetryPollerScheduler(
      { runOnce } as unknown as RetryPoller,
      fakeConfigService({ ...CONFIG, ...overrides }),
      registry,
      { run: (fn: () => unknown) => fn(), set: vi.fn() } as unknown as ClsService,
      fakePinoLogger({ error }),
    );
  return { make, runOnce, error, registry };
}

function pendingTick() {
  let release: () => void = () => {};
  const runOnce = vi.fn(() => new Promise<RetryTickSummary>((resolve) => (release = () => resolve(IDLE))));
  return { runOnce, release: () => release() };
}

describe('RetryPollerScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('refuses a missing or non-positive poll interval or batch size', () => {
    for (const overrides of [
      { 'messaging.retry.pollMs': undefined },
      { 'messaging.retry.batchSize': 0 },
      { 'messaging.retry.enabled': false, 'messaging.retry.pollMs': -1 },
    ]) {
      expect(() => build(overrides).make(), JSON.stringify(overrides)).toThrow(/Invalid config: messaging\.retry\./);
    }
  });

  it('ticks at the configured period and batch size until destroyed', async () => {
    const { make, runOnce } = build();
    const scheduler = make();

    scheduler.onModuleInit();
    await vi.advanceTimersByTimeAsync(1_000);
    scheduler.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(3_000);

    expect(runOnce).toHaveBeenCalledOnce();
    expect(runOnce.mock.calls[0][0]).toBe(50);
  });

  // An instance with its worker switched off must not quietly run handlers through the back door.
  it('schedules nothing unless both the retry poller and the worker are on', () => {
    for (const overrides of [{ 'messaging.retry.enabled': false }, { 'queue.workerEnabled': false }]) {
      const { make, registry } = build(overrides);

      make().onModuleInit();

      expect(registry.getIntervals(), JSON.stringify(overrides)).toEqual([]);
    }
  });

  it('skips a tick while the previous one is still working', async () => {
    const { runOnce, release } = pendingTick();
    const scheduler = build({}, runOnce).make();

    const first = scheduler.tick();
    await scheduler.tick();
    expect(runOnce).toHaveBeenCalledOnce();

    release();
    await first;
    runOnce.mockResolvedValue(IDLE);
    await scheduler.tick();
    expect(runOnce).toHaveBeenCalledTimes(2);
  });

  it('swallows a failed tick and keeps polling', async () => {
    const { make, runOnce, error } = build({}, vi.fn().mockRejectedValue(new Error('lease query failed')));
    const scheduler = make();

    await expect(scheduler.tick()).resolves.toBeUndefined();
    await scheduler.tick();

    expect(runOnce).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledTimes(2);
  });

  it('asks the open tick to stop leasing, then waits for it before shutting down', async () => {
    const { runOnce, release } = pendingTick();
    const scheduler = build({}, runOnce).make();

    const tick = scheduler.tick();
    const signal = (runOnce.mock.calls[0] as unknown[])[1] as AbortSignal;
    scheduler.onModuleDestroy();
    const settled = vi.fn();
    const teardown = scheduler.beforeApplicationShutdown().then(settled);

    expect(signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).not.toHaveBeenCalled();

    release();
    await tick;
    await teardown;
    expect(settled).toHaveBeenCalled();
  });

  it('gives up on a stuck tick instead of blocking shutdown forever', async () => {
    const scheduler = build(
      {},
      vi.fn(() => new Promise<RetryTickSummary>(() => {})),
    ).make();

    void scheduler.tick();
    scheduler.onModuleDestroy();
    const teardown = scheduler.beforeApplicationShutdown();

    await vi.advanceTimersByTimeAsync(10_000);
    await expect(teardown).resolves.toBeUndefined();
  });

  // The worker closes in beforeApplicationShutdown; waiting here would put this drain in front of it.
  it('stops polling at module destroy without waiting for the open tick', async () => {
    const { runOnce, release } = pendingTick();
    const scheduler = build({}, runOnce).make();
    scheduler.onModuleInit();

    const tick = scheduler.tick();
    expect(scheduler.onModuleDestroy()).toBeUndefined();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(runOnce).toHaveBeenCalledOnce();

    release();
    await tick;
  });
});
