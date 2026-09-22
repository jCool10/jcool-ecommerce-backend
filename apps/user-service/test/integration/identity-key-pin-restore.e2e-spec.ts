import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bucketForEmail, identityKeyFingerprint } from '@jcool/id-codec';
import { normalizeEmail } from '@jcool/kernel';
import { createTestUser } from '../setup/fixtures/user.fixture';
import { E2E_IDENTITY_BUCKET_KEY, WRONG_IDENTITY_BUCKET_KEY } from '../setup/identity.helper';
import { resetDatabase } from '../setup/reset-database';
import { createTestApp } from '../setup/test-app.factory';
import { workerDatabaseUrl } from '../setup/worker-resources';

const SCAN_LIMIT = 40_000;

function bucketsUnderBothKeys(email: string): [number, number] {
  const normalized = normalizeEmail(email);
  return [bucketForEmail(normalized, E2E_IDENTITY_BUCKET_KEY), bucketForEmail(normalized, WRONG_IDENTITY_BUCKET_KEY)];
}

/** Both keys route it to the same bucket, so the canary cannot tell them apart. */
function addressTheKeysAgreeAbout(): string {
  for (let i = 0; i < SCAN_LIMIT; i++) {
    const email = `key-pin-restore-${i}@test.local`;
    const [right, wrong] = bucketsUnderBothKeys(email);
    if (right === wrong) return email;
  }
  throw new Error('No test address collides under the two keys — has BUCKET_COUNT changed?');
}

function addressTheKeysDisagreeAbout(): string {
  for (let i = 0; i < SCAN_LIMIT; i++) {
    const email = `key-pin-restore-differing-${i}@test.local`;
    const [right, wrong] = bucketsUnderBothKeys(email);
    if (right !== wrong) return email;
  }
  throw new Error('No test address routes differently under the two keys — are they the same key?');
}

/**
 * A restore that loses `identity_key_pin` but keeps `users`: the one-row canary is all that stands
 * between the operator and a silently re-pinned wrong key.
 */
describe('Identity bucket key pin after a partial restore (integration)', () => {
  let pool: Pool;

  const boot = (env: Record<string, string> = {}): Promise<INestApplication> =>
    createTestApp({ IDENTITY_PIN_BOOTSTRAP: 'true', ...env });

  beforeAll(() => {
    pool = new Pool({ connectionString: workerDatabaseUrl() });
  });

  afterAll(async () => {
    // Every case leaves a wrong-key pin that would refuse the next file's boot in this worker.
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

  async function restoreWithoutThePin(emails: string[]): Promise<void> {
    const app = await boot();
    try {
      for (const email of emails) await createTestUser(app, { email });
    } finally {
      await app.close();
    }
    await pool.query(`DELETE FROM identity_key_pin`);
  }

  // Characterization of a known gap, not the intended behaviour: with bootstrap on, an absent pin
  // reads as a first boot (`onConflictDoNothing` in identity-bucket-key.verifier.ts), so whatever
  // key is running becomes the reference once the one-row canary is blind.
  it('adopts a wrong key as authoritative when the restore brought back users but not the pin', async () => {
    const blindSpot = addressTheKeysAgreeAbout();
    await restoreWithoutThePin([blindSpot]);

    const [right, wrong] = bucketsUnderBothKeys(blindSpot);
    expect(right).toBe(wrong);

    const app = await boot({ IDENTITY_BUCKET_KEY: WRONG_IDENTITY_BUCKET_KEY });
    try {
      expect(await pinnedFingerprints()).toEqual([identityKeyFingerprint(WRONG_IDENTITY_BUCKET_KEY)]);
    } finally {
      await app.close();
    }

    // From here on the real key is the one refused.
    await expect(boot()).rejects.toThrow(/does not match the key this database was built with/);
  });

  // Characterization, same gap: the canary samples the newest row only, so one unlucky newest row
  // silences a check every older row would have failed.
  it('samples only the newest user, so an older misrouted row cannot object', async () => {
    const wouldHaveCaughtIt = addressTheKeysDisagreeAbout();
    const blindSpot = addressTheKeysAgreeAbout();
    await restoreWithoutThePin([wouldHaveCaughtIt, blindSpot]);

    // Asserted, not assumed: which row the canary reaches is the whole point.
    expect(await newestUserEmail()).toBe(normalizeEmail(blindSpot));

    const app = await boot({ IDENTITY_BUCKET_KEY: WRONG_IDENTITY_BUCKET_KEY });
    try {
      expect(await pinnedFingerprints()).toEqual([identityKeyFingerprint(WRONG_IDENTITY_BUCKET_KEY)]);
    } finally {
      await app.close();
    }
  });
});
