import { HealthIndicatorService } from '@nestjs/terminus';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LeaseHealthIndicator } from './lease.health-indicator';
import { FakeLeaseStore } from './testing/fake-lease-store';
import { TEST_LEASE_CONFIG, testNodeLease } from './testing/test-node-lease';

async function heldLease() {
  const lease = testNodeLease(new FakeLeaseStore().grant(7));
  await lease.acquire();
  return lease;
}

describe('LeaseHealthIndicator', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('is up with the node id while a node is held', async () => {
    const indicator = new LeaseHealthIndicator(new HealthIndicatorService(), await heldLease());
    expect(indicator.isHealthy('lease')).toEqual({ lease: { status: 'up', nodeId: 7 } });
  });

  it('stays up while draining, since the replica still mints', async () => {
    const lease = await heldLease();
    lease.drain();
    expect(new LeaseHealthIndicator(new HealthIndicatorService(), lease).isHealthy('lease').lease?.status).toBe('up');
  });

  it('is down with the state once the fence is reached', async () => {
    const lease = await heldLease();
    vi.advanceTimersByTime(TEST_LEASE_CONFIG.ttlMs - TEST_LEASE_CONFIG.fenceMarginMs);
    const indicator = new LeaseHealthIndicator(new HealthIndicatorService(), lease);
    expect(indicator.isHealthy('lease')).toEqual({ lease: { status: 'down', state: 'fenced' } });
  });

  it('is down when the pool had no node to give', async () => {
    const lease = testNodeLease(new FakeLeaseStore().exhausted());
    await lease.acquire();
    const indicator = new LeaseHealthIndicator(new HealthIndicatorService(), lease);
    expect(indicator.isHealthy('lease')).toEqual({ lease: { status: 'down', state: 'exhausted' } });
  });
});
