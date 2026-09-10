import { describe, expect, it } from 'vitest';
import { computeHardTtlMs, isEnvelope, isFresh, makeEnvelope, type TtlPolicy } from './ttl-policy';

const POLICY: TtlPolicy = {
  softTtlMs: 60_000,
  staleWindowMs: 30_000,
  jitterMs: 10_000,
  leaseMs: 5_000,
  waitMs: 500,
};

describe('computeHardTtlMs', () => {
  it('spans soft + stale at the low end of the jitter and stops short of one full jitter at the high end', () => {
    expect(computeHardTtlMs(POLICY, () => 0)).toBe(90_000);
    expect(computeHardTtlMs(POLICY, () => 0.999_999)).toBeLessThan(100_000);
  });

  it('spreads keys written in the same instant across the jitter window', () => {
    const ttls = new Set(Array.from({ length: 50 }, () => computeHardTtlMs(POLICY)));
    expect(ttls.size).toBeGreaterThan(1);
    for (const ttl of ttls) {
      expect(ttl).toBeGreaterThanOrEqual(90_000);
      expect(ttl).toBeLessThan(100_000);
    }
  });

  it('collapses to a fixed expiry when jitter is switched off', () => {
    expect(computeHardTtlMs({ ...POLICY, jitterMs: 0 })).toBe(90_000);
  });
});

describe('envelope', () => {
  it('is fresh until the soft TTL elapses, then stale', () => {
    const envelope = makeEnvelope({ id: 'p1' }, POLICY, 1_000);
    expect(isFresh(envelope, 60_999)).toBe(true);
    expect(isFresh(envelope, 61_000)).toBe(false);
  });

  it('rejects a payload that is not an envelope, which would otherwise read as permanently stale', () => {
    expect(isEnvelope(makeEnvelope('x', POLICY))).toBe(true);
    expect(isEnvelope({ id: 'p1' })).toBe(false);
    expect(isEnvelope(null)).toBe(false);
  });
});
