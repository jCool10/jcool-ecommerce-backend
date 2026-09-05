import { normalizeEmail } from '@shared/kernel';
import { bucketForEmail, identityKeyFingerprint } from './email-bucket';
import { BUCKET_COUNT, bucketOf, encode } from './uuid-v8.codec';

const KEY = 'test-identity-bucket-key-not-a-real-secret-000';
const OTHER_KEY = 'test-identity-bucket-key-not-a-real-secret-001';

// Full N locally; reduced on CI. The chi-square verdict holds at either size — the
// threshold is on p, not on the sample count.
const DISTRIBUTION_SAMPLES = process.env.CI ? 100_000 : 1_000_000;
const ROUND_TRIP_SAMPLES = process.env.CI ? 20_000 : 100_000;

// Numerical Recipes `erfcc` (fractional error < 1.2e-7) — ample for a p > 0.01 verdict.
function erfc(x: number): number {
  const t = 1 / (1 + 0.5 * Math.abs(x));
  const poly =
    -1.26551223 +
    t *
      (1.00002368 +
        t *
          (0.37409196 +
            t *
              (0.09678418 +
                t *
                  (-0.18628806 +
                    t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277))))))));
  const answer = t * Math.exp(-x * x + poly);
  return x >= 0 ? answer : 2 - answer;
}

// Wilson–Hilferty: the cube root of a chi-square/df is near-normal, and df here is 4095.
function chiSquarePValue(chiSquare: number, df: number): number {
  const term = 2 / (9 * df);
  const z = (Math.cbrt(chiSquare / df) - (1 - term)) / Math.sqrt(term);
  return 0.5 * erfc(z / Math.SQRT2);
}

function chiSquare(counts: number[], total: number): number {
  const expected = total / counts.length;
  return counts.reduce((sum, observed) => sum + (observed - expected) ** 2 / expected, 0);
}

describe('email bucket', () => {
  // Frozen vectors. Every other assertion here is a property (in range, deterministic, key-dependent,
  // uniform), and a re-derivation that stays uniform satisfies all of them while moving every user to
  // a different bucket. The mapping is permanent, so the derivation itself has to be pinned.
  it('matches its known-answer vectors', () => {
    expect(bucketForEmail(normalizeEmail('alice@example.com'), KEY)).toBe(3019);
    expect(bucketForEmail(normalizeEmail('bob@example.com'), KEY)).toBe(2086);
    expect(bucketForEmail(normalizeEmail('user0@example.com'), KEY)).toBe(3918);
    expect(bucketForEmail(normalizeEmail('Round.Trip+1@Example.com'), KEY)).toBe(2862);
    expect(identityKeyFingerprint(KEY)).toBe('e45b6ab311262c87');
    expect(identityKeyFingerprint(OTHER_KEY)).toBe('aadb15336dbcde68');
  });

  it('derives a bucket inside the 12-bit range', () => {
    for (let i = 0; i < 1000; i++) {
      const bucket = bucketForEmail(normalizeEmail(`user${i}@example.com`), KEY);
      expect(Number.isInteger(bucket)).toBe(true);
      expect(bucket).toBeGreaterThanOrEqual(0);
      expect(bucket).toBeLessThan(BUCKET_COUNT);
    }
  });

  it('is deterministic and case/whitespace insensitive through normalizeEmail', () => {
    const bucket = bucketForEmail(normalizeEmail('Alice@Example.COM'), KEY);
    expect(bucketForEmail(normalizeEmail('  alice@example.com  '), KEY)).toBe(bucket);
    expect(bucketForEmail(normalizeEmail('alice@example.com'), KEY)).toBe(bucket);
  });

  it('routes the same email elsewhere under a different key', () => {
    let differing = 0;
    for (let i = 0; i < 1000; i++) {
      const email = normalizeEmail(`user${i}@example.com`);
      if (bucketForEmail(email, KEY) !== bucketForEmail(email, OTHER_KEY)) differing++;
    }
    // Two independent draws from 4096 buckets collide ~1/4096 of the time; anything near 1000 proves
    // the key actually participates (a plain digest would score 0 here).
    expect(differing).toBeGreaterThan(990);
  });

  it('survives the id round trip: email -> id -> bucket', () => {
    for (let i = 0; i < ROUND_TRIP_SAMPLES; i++) {
      const email = normalizeEmail(`Round.Trip+${i}@Example.com`);
      const bucket = bucketForEmail(email, KEY);
      const id = encode({ tsMs: 1_756_000_000_000 + i, bucket, nodeId: 0, sequence: i % 4096, random: i });
      expect(bucketOf(id)).toBe(bucket);
    }
  }, 60_000);

  it('spreads emails uniformly across all 4096 buckets', () => {
    const counts = new Array<number>(BUCKET_COUNT).fill(0);
    for (let i = 0; i < DISTRIBUTION_SAMPLES; i++) {
      counts[bucketForEmail(normalizeEmail(`user${i}@example.com`), KEY)]++;
    }

    const p = chiSquarePValue(chiSquare(counts, DISTRIBUTION_SAMPLES), BUCKET_COUNT - 1);
    expect(p).toBeGreaterThan(0.01);
    expect(counts.filter((count) => count === 0)).toHaveLength(0);
  }, 120_000);

  it('the uniformity test can fail: a half-range histogram scores p ~ 0', () => {
    const skewed = new Array<number>(BUCKET_COUNT).fill(0);
    const total = 100_000;
    for (let i = 0; i < total; i++) skewed[i % (BUCKET_COUNT / 2)]++;

    expect(chiSquarePValue(chiSquare(skewed, total), BUCKET_COUNT - 1)).toBeLessThan(0.01);
  });
});

describe('identity key fingerprint', () => {
  it('is stable for one key and differs across keys', () => {
    expect(identityKeyFingerprint(KEY)).toBe(identityKeyFingerprint(KEY));
    expect(identityKeyFingerprint(KEY)).not.toBe(identityKeyFingerprint(OTHER_KEY));
  });

  it('changes on a single-character key edit', () => {
    expect(identityKeyFingerprint(`${KEY}x`)).not.toBe(identityKeyFingerprint(KEY));
    expect(identityKeyFingerprint(KEY.replace('test', 'Test'))).not.toBe(identityKeyFingerprint(KEY));
  });

  // Computable with an empty users table — the property the DB key pin rests on.
  it('is 16 lowercase hex chars derived from the key alone', () => {
    expect(identityKeyFingerprint(KEY)).toMatch(/^[0-9a-f]{16}$/);
  });
});
