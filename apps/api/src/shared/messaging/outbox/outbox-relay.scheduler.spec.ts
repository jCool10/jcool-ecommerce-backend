import { SchedulerRegistry } from '@nestjs/schedule';
import type { ClsService } from 'nestjs-cls';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OutboxRelay, RelayTickSummary } from './outbox-relay';
import { OutboxRelayScheduler } from './outbox-relay.scheduler';

const CONFIG: Record<string, unknown> = {
  'outbox.relayEnabled': true,
  'outbox.pollMs': 1_000,
  'outbox.batchSize': 100,
};

const IDLE: RelayTickSummary = { published: 0, failed: 0 };

function build(overrides: Record<string, unknown> = {}, runOnce = vi.fn().mockResolvedValue(IDLE)) {
  const error = vi.fn();
  const make = () =>
    new OutboxRelayScheduler(
      { runOnce } as unknown as OutboxRelay,
      fakeConfigService({ ...CONFIG, ...overrides }),
      new SchedulerRegistry(),
      { run: (fn: () => unknown) => fn(), set: vi.fn() } as unknown as ClsService,
      fakePinoLogger({ error }),
    );
  return { make, runOnce, error };
}

function pendingTick() {
  let release: () => void = () => {};
  const runOnce = vi.fn(() => new Promise<RelayTickSummary>((resolve) => (release = () => resolve(IDLE))));
  return { runOnce, release: () => release() };
}

describe('OutboxRelayScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // An unset interval makes setInterval fire every event-loop turn, each tick opening a transaction.
  it('refuses a missing or non-positive poll interval or batch size', () => {
    for (const overrides of [
      { 'outbox.pollMs': undefined },
      { 'outbox.batchSize': undefined },
      { 'outbox.pollMs': 0 },
      { 'outbox.relayEnabled': false, 'outbox.batchSize': -1 },
    ]) {
      expect(() => build(overrides).make(), JSON.stringify(overrides)).toThrow(/Invalid outbox relay config/);
    }
  });

  it('ticks at the configured period and batch size until destroyed', async () => {
    const { make, runOnce } = build();
    const scheduler = make();

    scheduler.onModuleInit();
    await vi.advanceTimersByTimeAsync(1_000);
    await scheduler.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(3_000);

    expect(runOnce.mock.calls).toEqual([[100]]);
    await expect(build({ 'outbox.relayEnabled': false }).make().onModuleDestroy()).resolves.toBeUndefined();
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

  // An unhandled rejection in a timer callback kills the process.
  it('swallows a failed tick and keeps polling', async () => {
    const { make, runOnce, error } = build({}, vi.fn().mockRejectedValue(new Error('outbox poll failed')));
    const scheduler = make();

    await expect(scheduler.tick()).resolves.toBeUndefined();
    await scheduler.tick();

    expect(runOnce).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledTimes(2);
  });

  it('waits for an open tick to finish before shutting down', async () => {
    const { runOnce, release } = pendingTick();
    const scheduler = build({}, runOnce).make();

    const tick = scheduler.tick();
    const settled = vi.fn();
    const teardown = scheduler.onModuleDestroy().then(settled);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).not.toHaveBeenCalled();

    release();
    await tick;
    await teardown;
    expect(settled).toHaveBeenCalled();
  });

  it('gives up on a stuck tick instead of blocking shutdown forever', async () => {
    const stuck = vi.fn(() => new Promise<RelayTickSummary>(() => {}));
    const scheduler = build({}, stuck).make();

    void scheduler.tick();
    const teardown = scheduler.onModuleDestroy();

    await vi.advanceTimersByTimeAsync(5_000);
    await expect(teardown).resolves.toBeUndefined();
  });
});
