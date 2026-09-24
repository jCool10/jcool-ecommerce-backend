import { describe, expect, it } from 'vitest';
import { computeHardTtlMs, isFresh, makeEnvelope, type TtlPolicy } from './ttl-policy';

const POLICY: TtlPolicy = {
  softTtlMs: 60_000,
  staleWindowMs: 30_000,
  jitterMs: 10_000,
  leaseMs: 5_000,
  waitMs: 500,
};

describe('ttl policy', () => {
  it('expires under one jitter after soft + stale, and exactly then without jitter', () => {
    expect(computeHardTtlMs(POLICY, () => 0)).toBe(90_000);
    expect(computeHardTtlMs(POLICY, () => 0.999_999)).toBeLessThan(100_000);
    expect(computeHardTtlMs({ ...POLICY, jitterMs: 0 })).toBe(90_000);
  });

  it('is fresh until the soft TTL elapses, then stale', () => {
    const envelope = makeEnvelope({ id: 'p1' }, POLICY, 1_000);
    expect(isFresh(envelope, 60_999)).toBe(true);
    expect(isFresh(envelope, 61_000)).toBe(false);
  });
});
