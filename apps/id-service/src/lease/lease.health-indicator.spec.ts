import { HealthIndicatorService } from '@nestjs/terminus';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NodeLease } from '@jcool/id-generator';
import { LeaseHealthIndicator } from './lease.health-indicator';
import { FakeLeaseStore } from './testing/fake-lease-store';
import { TEST_LEASE_CONFIG, testNodeLease } from './testing/test-node-lease';

async function heldLease(): Promise<NodeLease> {
  const lease = testNodeLease(new FakeLeaseStore().grant(7));
  await lease.acquire();
  return lease;
}

const readiness = (lease: NodeLease) =>
  new LeaseHealthIndicator(new HealthIndicatorService(), lease).isHealthy('lease');

describe('LeaseHealthIndicator', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  // Draining still mints, so the replica stays in rotation until it releases the node.
  it('is up with the node id while a node is held or draining', async () => {
    const lease = await heldLease();
    expect(readiness(lease)).toEqual({ lease: { status: 'up', nodeId: 7 } });

    lease.drain();
    expect(readiness(lease)).toEqual({ lease: { status: 'up', nodeId: 7 } });
  });

  it('is down with the state once fenced or when the pool had no node to give', async () => {
    const fenced = await heldLease();
    vi.advanceTimersByTime(TEST_LEASE_CONFIG.ttlMs - TEST_LEASE_CONFIG.fenceMarginMs);
    const exhausted = testNodeLease(new FakeLeaseStore().exhausted());
    await exhausted.acquire();

    expect(readiness(fenced)).toEqual({ lease: { status: 'down', state: 'fenced' } });
    expect(readiness(exhausted)).toEqual({ lease: { status: 'down', state: 'exhausted' } });
  });
});
