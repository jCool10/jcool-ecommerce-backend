import { type LeaseStore, NodeLease } from '@jcool/id-generator';
import type { LeaseConfig } from '../../config/configuration';

export const TEST_LEASE_CONFIG: LeaseConfig = {
  holder: 'replica-a/host/1',
  ttlMs: 300_000,
  renewEveryMs: 60_000,
  quarantineMs: 10_000,
  fenceMarginMs: 15_000,
  maxFloorAheadMs: 15_000,
};

/** Both clocks follow `Date.now()`, so fake timers move them together and never read as a suspend. */
export function testNodeLease(store: LeaseStore, config: LeaseConfig = TEST_LEASE_CONFIG): NodeLease {
  let elapsedNs = 0n;
  return NodeLease.createWithClock({
    ...config,
    store,
    clock: { wallMs: () => Date.now(), monotonicMs: () => Date.now(), elapsedNs: () => (elapsedNs += 1_000n) },
  });
}
