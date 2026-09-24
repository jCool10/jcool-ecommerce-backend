import { normalizeEmail } from '@jcool/kernel';
import { bucketForEmail, identityKeyFingerprint } from './email-bucket';
import { BUCKET_COUNT } from './snowflake.codec';

const KEY = 'test-identity-bucket-key-not-a-real-secret-000';
const OTHER_KEY = 'test-identity-bucket-key-not-a-real-secret-001';
const DISTRIBUTION_SAMPLES = 100_000;
// Chi-square critical value for 4095 degrees of freedom at p = 0.01.
const CHI_SQUARE_LIMIT = 4308;

describe('email bucket', () => {
  // Stored ids carry the bucket and each database pins the key fingerprint, so both derivations are
  // permanent. A re-derivation that stays uniform passes the property tests below while moving every
  // user; only frozen vectors catch it.
  it('matches its known-answer vectors', () => {
    expect(bucketForEmail(normalizeEmail('alice@example.com'), KEY)).toBe(3019);
    expect(bucketForEmail(normalizeEmail('bob@example.com'), KEY)).toBe(2086);
    expect(bucketForEmail(normalizeEmail('user0@example.com'), KEY)).toBe(3918);
    expect(bucketForEmail(normalizeEmail('Round.Trip+1@Example.com'), KEY)).toBe(2862);
    expect(identityKeyFingerprint(KEY)).toBe('e45b6ab311262c87');
    expect(identityKeyFingerprint(OTHER_KEY)).toBe('aadb15336dbcde68');
  });

  it('routes the same email elsewhere under a different key', () => {
    let differing = 0;
    for (let i = 0; i < 1000; i++) {
      const email = normalizeEmail(`user${i}@example.com`);
      if (bucketForEmail(email, KEY) !== bucketForEmail(email, OTHER_KEY)) differing++;
    }
    // Independent draws from 4096 buckets collide about 1 in 4096 times; an unkeyed digest would score 0.
    expect(differing).toBeGreaterThan(990);
  });

  it('spreads emails uniformly across all 4096 buckets', () => {
    const counts = new Array<number>(BUCKET_COUNT).fill(0);
    for (let i = 0; i < DISTRIBUTION_SAMPLES; i++) {
      counts[bucketForEmail(normalizeEmail(`user${i}@example.com`), KEY)]++;
    }
    const expected = DISTRIBUTION_SAMPLES / BUCKET_COUNT;
    const chiSquare = counts.reduce((sum, observed) => sum + (observed - expected) ** 2 / expected, 0);

    expect(counts).toHaveLength(BUCKET_COUNT);
    expect(Math.min(...counts)).toBeGreaterThan(0);
    expect(chiSquare).toBeLessThan(CHI_SQUARE_LIMIT);
  });
});
