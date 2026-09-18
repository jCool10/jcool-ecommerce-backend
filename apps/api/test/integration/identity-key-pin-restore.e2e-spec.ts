import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bucketForEmail, identityKeyFingerprint } from '../../src/shared/identity';
import { normalizeEmail } from '../../src/shared/kernel/normalize-email';
import { createTestUser } from '../setup/fixtures/user.fixture';
import { E2E_IDENTITY_BUCKET_KEY, WRONG_IDENTITY_BUCKET_KEY } from '../setup/identity.helper';
import { resetDatabase } from '../setup/reset-database';
import { createTestApp } from '../setup/test-app.factory';
import { workerDatabaseUrl } from '../setup/worker-resources';

// 1 in BUCKET_COUNT of addresses collide, so a linear scan finds one quickly; computed rather than
// hardcoded so a change to BUCKET_COUNT or to either key produces a new address instead of a
// mysterious failure here.
const SCAN_LIMIT = 40_000;

function bucketsUnderBothKeys(email: string): [number, number] {
  const normalized = normalizeEmail(email);
  return [bucketForEmail(normalized, E2E_IDENTITY_BUCKET_KEY), bucketForEmail(normalized, WRONG_IDENTITY_BUCKET_KEY)];
}

/** An address the canary is blind to: both keys route it to the same bucket, so both agree. */
function addressTheKeysAgreeAbout(): string {
  for (let i = 0; i < SCAN_LIMIT; i++) {
    const email = `key-pin-restore-${i}@test.local`;
    const [right, wrong] = bucketsUnderBothKeys(email);
    if (right === wrong) return email;
  }
  throw new Error('No test address collides under the two keys — has BUCKET_COUNT changed?');
}

/** The canary's only useful sample: an address the two keys route differently. */
function addressTheKeysDisagreeAbout(): string {
  for (let i = 0; i < SCAN_LIMIT; i++) {
    const email = `key-pin-restore-differing-${i}@test.local`;
    const [right, wrong] = bucketsUnderBothKeys(email);
    if (right !== wrong) return email;
  }
  throw new Error('No test address routes differently under the two keys — are they the same key?');
}

/**
 * The restore that loses one table: a dump taken before `identity_key_pin` existed, a selective
 * restore, a migration rerun on a copy. `users` survives with every id minted under the original
 * key, and the only thing standing between the operator and a silently re-pinned wrong key is a
 * single-row canary.
 */
describe('Identity bucket key pin after a partial restore (integration)', () => {
  let pool: Pool;

  beforeAll(() => {
    // This worker's database, the same one createTestApp boots against — the pin row is per-worker.
    pool = new Pool({ connectionString: workerDatabaseUrl() });
  });

  afterAll(async () => {
    // Every test here leaves a fingerprint from a key nothing else in the run uses, and other spec
    // files boot their app before their own truncate — so the next one would be refused at boot.
    await resetDatabase(pool);
    await pool.end();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
  });

  const pinnedFingerprints = async (): Promise<string[]> => {
    const { rows } = await pool.query<{ fingerprint: string }>(`SELECT fingerprint FROM identity_key_pin`);
    return rows.map((row) => row.fingerprint);
  };

  const newestUserEmail = async (): Promise<string> => {
    const { rows } = await pool.query<{ email: string }>(`SELECT email FROM users ORDER BY id DESC LIMIT 1`);
    return rows[0].email;
  };

  /** Seeds users under the real key, then drops the pin the restore did not bring back. */
  async function restoreWithoutThePin(emails: string[]): Promise<void> {
    const app = await createTestApp();
    try {
      for (const email of emails) await createTestUser(app, { email });
    } finally {
      await app.close();
    }
    await pool.query(`DELETE FROM identity_key_pin`);
  }

  // CHARACTERIZATION — pins today's behaviour, which is NOT the intended one.
  //
  // Intended invariant: a database holding ids minted under one key can never adopt a different key
  //   as its reference — that is the entire purpose of the pin.
  // Violated at: src/modules/user/infrastructure/identity-bucket-key.verifier.ts:63-75 — the pin is
  //   written with `insert(...).onConflictDoNothing()`, so an ABSENT pin row is indistinguishable
  //   from a first boot and whatever key is running becomes authoritative. On a partial restore the
  //   users are still there, so the only remaining defence is `verifyNewestUserRow` at :105-113,
  //   which samples ONE row: it is blind whenever that row's email happens to hash to the same
  //   bucket under both keys — 1 in BUCKET_COUNT (4096) of addresses — and blind entirely when
  //   `users` came back empty. The wrong key is then pinned as the reference every later boot is
  //   held to, and ids minted from here on are misfiled with nothing left to notice.
  // Follow-up: plans/260910-1940-edge-case-invariant-fixes/plan.md — ID-2.
  it('adopts a wrong key as authoritative when the restore brought back users but not the pin', async () => {
    const blindSpot = addressTheKeysAgreeAbout();
    await restoreWithoutThePin([blindSpot]);

    // The canary has a row to sample and still cannot object: this address routes identically under
    // both keys, so the one check that could have spoken agrees with the wrong key.
    const [right, wrong] = bucketsUnderBothKeys(blindSpot);
    expect(right).toBe(wrong);

    const app = await createTestApp({ IDENTITY_BUCKET_KEY: WRONG_IDENTITY_BUCKET_KEY });
    try {
      // Booted, and the database now says it was built with a key it was not.
      expect(await pinnedFingerprints()).toEqual([identityKeyFingerprint(WRONG_IDENTITY_BUCKET_KEY)]);
    } finally {
      await app.close();
    }

    // And the pin is authoritative from here on — the REAL key is now the one refused.
    await expect(createTestApp()).rejects.toThrow(/does not match the key this database was built with/);
  });

  // The same restore, with a table full of rows that would have caught it — and one that would not
  // sitting on top.
  //
  // CHARACTERIZATION — pins today's behaviour, which is NOT the intended one.
  //
  // Intended invariant: a database restored under the wrong identity key is refused, whatever the
  //   table happens to contain.
  // Violated at: src/modules/user/infrastructure/identity-bucket-key.verifier.ts:113 —
  //   `orderBy(desc(users.id)).limit(1)` samples the newest row only, so the size of the table buys
  //   nothing and whether the guard speaks is decided by whichever user registered last. Roughly
  //   half of all addresses route identically under either key, so a single unlucky newest row
  //   silences a check that every other row in the table would have failed.
  // Follow-up: plans/260910-1940-edge-case-invariant-fixes/plan.md — ID-1.
  it('samples only the newest user, so an older misrouted row cannot object', async () => {
    const wouldHaveCaughtIt = addressTheKeysDisagreeAbout();
    const blindSpot = addressTheKeysAgreeAbout();
    await restoreWithoutThePin([wouldHaveCaughtIt, blindSpot]);

    // Ordering asserted rather than assumed: the id leads with a millisecond timestamp, and the
    // whole point of this case is WHICH row the canary reaches.
    expect(await newestUserEmail()).toBe(normalizeEmail(blindSpot));

    const app = await createTestApp({ IDENTITY_BUCKET_KEY: WRONG_IDENTITY_BUCKET_KEY });
    try {
      expect(await pinnedFingerprints()).toEqual([identityKeyFingerprint(WRONG_IDENTITY_BUCKET_KEY)]);
    } finally {
      await app.close();
    }
  });
});
