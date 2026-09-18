import { createHmac } from 'node:crypto';
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
  //
  // The two `identityKeyFingerprint` vectors are the exception to "permanent": ID-1 (matrix q5) asks
  // whether the fingerprint should mix `BUCKET_COUNT` in, and if it does, both values change by
  // design. Re-pinning them is part of that fix, not a signal it went wrong — the four bucket
  // vectors above are the ones that must never move.
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

// `bucketForEmail` under a smaller bucket space, derived exactly as the shipped one is. Halving the
// modulus is the cheapest realistic shape of a layout change (a resharding, a widened id field), and
// it is the change the assertions below ask the guards about.
function bucketUnderHalvedLayout(email: string, key: string): number {
  return createHmac('sha256', key).update(email, 'utf8').digest().readUInt16BE(0) % (BUCKET_COUNT / 2);
}

describe('bucket layout changes', () => {
  // CHARACTERIZATION — pins today's behaviour, which is NOT the intended one.
  //
  // Intended invariant: the boot guards refuse a running process whose bucket LAYOUT disagrees with
  //   the one the stored ids were minted under — a wrong modulus misfiles rows exactly the way a
  //   wrong key does.
  // Violated at: src/shared/identity/email-bucket.ts:25-26 — `identityKeyFingerprint` HMACs a fixed
  //   sentinel under the key and nothing else, so `BUCKET_COUNT` never reaches the pin and the
  //   fingerprint is byte-identical across a layout change. That leaves only the single-row canary in
  //   src/modules/user/infrastructure/identity-bucket-key.verifier.ts:105-113, and under a halved
  //   layout roughly half of all addresses land in the same bucket either way — so whether the boot
  //   is refused is decided by which user happened to register last.
  // Follow-up: plans/260910-1940-edge-case-invariant-fixes/plan.md — ID-1 (and matrix q5: whether
  //   the fingerprint should mix `BUCKET_COUNT`, which re-pins every existing database once).
  it('leaves the key fingerprint byte-identical while moving half of all users', () => {
    // The pin sees nothing: its input is the key, and the key did not change.
    expect(identityKeyFingerprint(KEY)).toBe('e45b6ab311262c87');

    let agreeing = 0;
    const samples = 20_000;
    for (let i = 0; i < samples; i++) {
      const email = normalizeEmail(`layout${i}@example.com`);
      if (bucketForEmail(email, KEY) === bucketUnderHalvedLayout(email, KEY)) agreeing++;
    }

    // A bucket below BUCKET_COUNT/2 is unchanged by the halving; one above it moves. That makes the
    // newest-row canary a coin flip rather than a guard.
    const agreementRate = agreeing / samples;
    expect(agreementRate).toBeGreaterThan(0.45);
    expect(agreementRate).toBeLessThan(0.55);
  });

  // The half that does move, moves for good: an id minted under one layout does not decode to the
  // bucket its email hashes to under the other, so the damage is the same as a wrong key's.
  //
  // Same CHARACTERIZATION and the same follow-up as the test above (ID-1). The load-bearing line
  // here is the fingerprint: the first two assertions only restate how `moved` was selected and that
  // the codec round-trips, both of which are proven elsewhere in this file. What makes the test
  // discriminate is that the ONE production surface which could notice — the pin — is unchanged.
  it('misfiles the users it does move, with nothing in the pin able to notice', () => {
    const moved = (() => {
      for (let i = 0; i < 1000; i++) {
        const email = normalizeEmail(`layout${i}@example.com`);
        if (bucketForEmail(email, KEY) !== bucketUnderHalvedLayout(email, KEY)) return email;
      }
      throw new Error('No sampled address changes bucket under a halved layout — has BUCKET_COUNT changed?');
    })();

    const minted = encode({
      tsMs: 1_756_000_000_000,
      bucket: bucketForEmail(moved, KEY),
      nodeId: 0,
      sequence: 1,
      random: 1,
    });

    // Preconditions, restated so the assertion below is readable: the id keeps the bucket it was
    // minted under, and a lookup for the same address under the halved layout goes somewhere else.
    expect(bucketOf(minted)).toBe(bucketForEmail(moved, KEY));
    expect(bucketUnderHalvedLayout(moved, KEY)).not.toBe(bucketOf(minted));

    // The claim: nothing in `src/` can tell. The pin the verifier compares on the next boot is an
    // HMAC of a fixed sentinel under the key alone (email-bucket.ts:25-26), so the layout change
    // that stranded this row leaves it byte-identical. ID-1 mixing `BUCKET_COUNT` into the
    // fingerprint is exactly what turns this line red.
    expect(identityKeyFingerprint(KEY)).toBe('e45b6ab311262c87');
  });
});
