import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Counter } from 'prom-client';
import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import type { LeaseConfig } from '../config/configuration';
import { LeaseKeeper } from './lease-keeper.service';
import { FakeLeaseStore } from './testing/fake-lease-store';
import { TEST_LEASE_CONFIG as LEASE, testNodeLease } from './testing/test-node-lease';

const clockMetrics = vi.hoisted(() => ({
  bindIdentityClockMetrics: vi.fn(),
  unbindIdentityClockMetrics: vi.fn(),
}));
vi.mock('@jcool/platform/metrics', () => clockMetrics);

const START_MS = 1_800_000_000_000;
const HOLDER = LEASE.holder;
const GRACE_MS = 8_000;
const RETRY_MS = 1_000;

function counter(name: string): Counter {
  return new Counter({ name, help: name, registers: [] });
}

async function valueOf(metric: Counter): Promise<number> {
  return (await metric.get()).values[0]?.value ?? 0;
}

function setup(overrides: Partial<LeaseConfig> = {}, graceMs = GRACE_MS) {
  const lease = { ...LEASE, ...overrides };
  const store = new FakeLeaseStore();
  const nodeLease = testNodeLease(store, lease);
  const counters = {
    renewFailures: counter('renew_failures_total'),
    losses: counter('lost_total'),
    floorRejections: counter('floor_rejections_total'),
  };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const keeper = new LeaseKeeper(
    nodeLease,
    fakeConfigService({ lease, 'app.shutdownGracePeriodMs': graceMs }),
    fakePinoLogger(log),
    counters.renewFailures,
    counters.losses,
    counters.floorRejections,
  );
  return { store, lease: nodeLease, keeper, counters, log };
}

describe('LeaseKeeper', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('refuses a renew interval the fence would beat', () => {
    expect(() => setup({ renewEveryMs: LEASE.ttlMs - LEASE.fenceMarginMs })).toThrow(RangeError);
  });

  it('renews on schedule', async () => {
    const { store, keeper } = setup();
    store.grant(7);
    await keeper.onApplicationBootstrap();

    await vi.advanceTimersByTimeAsync(LEASE.renewEveryMs - 1);
    expect(store.renewals).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(store.renewals).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(LEASE.renewEveryMs);
    expect(store.renewals).toHaveLength(2);
  });

  it('mints through failed renewals until the fence, then resumes on a renewal', async () => {
    const { store, lease, keeper, counters, log } = setup();
    store.grant(7);
    await keeper.onApplicationBootstrap();
    store.renewResult = new Error('connection refused');

    await vi.advanceTimersByTimeAsync(LEASE.renewEveryMs + RETRY_MS);
    expect(store.renewals).toHaveLength(2);
    expect(await valueOf(counters.renewFailures)).toBe(2);
    // One warning per failure streak, not one per retry.
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(lease.generate(1)).toEqual(expect.any(String));

    await vi.advanceTimersByTimeAsync(LEASE.ttlMs - LEASE.fenceMarginMs - LEASE.renewEveryMs - RETRY_MS);
    expect(lease.state).toBe('fenced');

    store.renewResult = true;
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect(lease.state).toBe('held');
  });

  it('stops minting the moment a renewal finds the lease gone, then takes another node', async () => {
    const { store, lease, keeper, counters } = setup();
    store.grant(7).grant(8);
    await keeper.onApplicationBootstrap();
    const lost = lease.generator;
    store.renewResult = false;

    await vi.advanceTimersByTimeAsync(LEASE.renewEveryMs);

    expect(await valueOf(counters.losses)).toBe(1);
    expect(lease.nodeId).toBe(8);
    // The drift gauge follows the generator that mints now, not the one that was lost.
    expect(clockMetrics.unbindIdentityClockMetrics).toHaveBeenCalledWith(lost);
    expect(clockMetrics.bindIdentityClockMetrics).toHaveBeenLastCalledWith(lease.generator);
  });

  // With every free node's floor ahead (a database clock stepped back), an immediate retry would spin
  // through the pool, and with no quarantine on the same node forever.
  it('hands back nodes whose floor runs too far ahead, pausing between tries', async () => {
    const { store, lease, keeper, counters, log } = setup();
    const ahead = START_MS + LEASE.maxFloorAheadMs + 1;
    store
      .grant(7, ahead)
      .grant(8, ahead + RETRY_MS)
      .grant(9);

    await keeper.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(RETRY_MS - 1);
    expect(store.acquisitions).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1 + RETRY_MS);

    expect(await valueOf(counters.floorRejections)).toBe(2);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(store.releases).toEqual([
      expect.objectContaining({ nodeId: 7, lastMs: null }),
      expect.objectContaining({ nodeId: 8, lastMs: null }),
    ]);
    expect(lease.nodeId).toBe(9);
  });

  it('reports an exhausted pool once and keeps asking until a node frees up', async () => {
    const { store, lease, keeper, log } = setup();
    store.exhausted().exhausted().grant(9);

    await keeper.onApplicationBootstrap();
    expect(lease.state).toBe('exhausted');

    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect(lease.state).toBe('exhausted');

    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect(lease.nodeId).toBe(9);
    expect(log.error).toHaveBeenCalledTimes(1);
  });

  it('boots without a node while the store is down, and acquires once it answers', async () => {
    const { store, lease, keeper } = setup();
    store.fail(new Error('connection refused')).grant(4);

    await expect(keeper.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(lease.nodeId).toBeUndefined();

    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect(lease.nodeId).toBe(4);
  });

  it('takes no new node when the lease is lost while draining', async () => {
    const { store, lease, keeper } = setup({}, LEASE.renewEveryMs * 2);
    store.grant(7).grant(8);
    await keeper.onApplicationBootstrap();
    store.renewResult = false;

    void keeper.beforeApplicationShutdown();
    await vi.advanceTimersByTimeAsync(LEASE.renewEveryMs);

    expect(lease.state).toBe('lost');
    expect(store.acquisitions).toHaveLength(1);
  });

  it('waits for an in-flight renewal before releasing, and schedules nothing after', async () => {
    const { store, keeper } = setup();
    store.grant(7);
    await keeper.onApplicationBootstrap();
    let answer: (renewed: boolean) => void = () => undefined;
    store.renewResult = new Promise<boolean>((resolve) => (answer = resolve));
    await vi.advanceTimersByTimeAsync(LEASE.renewEveryMs);

    const shutdown = keeper.onApplicationShutdown();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.releases).toHaveLength(0);

    answer(true);
    await shutdown;
    expect(store.releases).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shuts down cleanly without a node, and when the release itself fails', async () => {
    const idle = setup();
    await idle.keeper.onApplicationBootstrap();
    await expect(idle.keeper.onApplicationShutdown()).resolves.toBeUndefined();
    expect(idle.store.releases).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);

    const held = setup();
    held.store.grant(7);
    await held.keeper.onApplicationBootstrap();
    held.store.releaseResult = new Error('connection refused');
    await expect(held.keeper.onApplicationShutdown()).resolves.toBeUndefined();
    expect(held.store.releases).toEqual([expect.objectContaining({ nodeId: 7, holder: HOLDER })]);
  });
});
