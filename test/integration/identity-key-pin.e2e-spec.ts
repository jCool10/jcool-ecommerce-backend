import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { bucketForEmail, identityKeyFingerprint } from '../../src/shared/identity';
import { normalizeEmail } from '../../src/shared/kernel/normalize-email';
import { createTestUser } from '../setup/fixtures/user.fixture';
import { E2E_IDENTITY_BUCKET_KEY, WRONG_IDENTITY_BUCKET_KEY } from '../setup/identity.helper';
import { resetDatabase } from '../setup/reset-database';
import { createTestApp } from '../setup/test-app.factory';

// The bucket key is permanent, and booting under the wrong one misfiles every id minted from then
// on — silently, because nothing reads a bucket until a shard split years later. These are the two
// guards that make that loud, driven through a real application boot rather than a constructed
// verifier: the unit suite proves the branches, this proves the wiring reaches them.
describe('Identity bucket key boot guards (integration)', () => {
  let pool: Pool;

  const password = 'Password123!';

  // The canary compares one row's carried bucket against the bucket its address hashes to under the
  // running key, so the address has to be one the two keys disagree about — otherwise the canary
  // passes and the pin raises a different error than the one under test.
  function addressTheKeysDisagreeAbout(): string {
    for (let i = 0; i < 100; i++) {
      const email = `key-pin-canary-${i}@test.local`;
      const normalized = normalizeEmail(email);
      if (
        bucketForEmail(normalized, E2E_IDENTITY_BUCKET_KEY) !== bucketForEmail(normalized, WRONG_IDENTITY_BUCKET_KEY)
      ) {
        return email;
      }
    }
    throw new Error('No test address routes differently under the two keys — are they the same key?');
  }

  beforeAll(() => {
    pool = new Pool({ connectionString: inject('DATABASE_URL') });
  });

  afterAll(async () => {
    // The last test leaves a fingerprint from a key nothing in the run uses; every other spec file
    // boots its app ahead of its own truncate, so the next one would be refused at boot.
    await resetDatabase(pool);
    await pool.end();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
  });

  it('pins the running key the first time it boots against a database', async () => {
    const app = await createTestApp();
    try {
      const { rows } = await pool.query<{ fingerprint: string }>(`SELECT fingerprint FROM identity_key_pin`);

      expect(rows).toEqual([{ fingerprint: identityKeyFingerprint(E2E_IDENTITY_BUCKET_KEY) }]);
    } finally {
      await app.close();
    }
  });

  // No rows to sample, so the canary has nothing to say — this is the case it structurally cannot
  // catch, and the reason the pin exists at all.
  it('refuses to boot under a different key against an empty database', async () => {
    await (await createTestApp()).close();

    await expect(createTestApp({ IDENTITY_BUCKET_KEY: WRONG_IDENTITY_BUCKET_KEY })).rejects.toThrow(
      /does not match the key this database was built with/,
    );
  });

  // Ordering, not just detection: the pin writes, and a pin recorded before the canary has spoken
  // would hold every later boot to the wrong key and blame the database for it.
  it('refuses on a misrouted row without pinning the key that found it', async () => {
    const first = await createTestApp();
    await createTestUser(first, { email: addressTheKeysDisagreeAbout() });
    await first.close();
    await pool.query(`DELETE FROM identity_key_pin`);

    await expect(createTestApp({ IDENTITY_BUCKET_KEY: WRONG_IDENTITY_BUCKET_KEY })).rejects.toThrow(
      /does not route to the bucket its email hashes to/,
    );

    const { rows } = await pool.query(`SELECT 1 FROM identity_key_pin`);
    expect(rows).toHaveLength(0);
  });

  // Fail open: the app cannot serve without its database anyway, and no id is minted while it is
  // down, so a guard that fails closed here would only add an outage to an outage.
  it('boots and mints when the pin cannot be read at all', async () => {
    // Renamed rather than dropped: every later spec file in the run shares this database.
    await pool.query(`ALTER TABLE identity_key_pin RENAME TO identity_key_pin_unreachable`);
    try {
      const app = await createTestApp();
      try {
        await request(app.getHttpServer())
          .post('/auth/register')
          .send({ email: 'key-pin-fail-open@test.local', password })
          .expect(201);
      } finally {
        await app.close();
      }
    } finally {
      await pool.query(`ALTER TABLE identity_key_pin_unreachable RENAME TO identity_key_pin`);
    }
  });

  // A database was built under one key, so a second pinned fingerprint would mean two answers to
  // which one — and the boot guard reads the row by primary key without noticing there were others.
  it('holds the pin to a single row', async () => {
    await pool.query(`INSERT INTO identity_key_pin (id, fingerprint) VALUES (1, 'deadbeefdeadbeef')`);

    await expect(
      pool.query(`INSERT INTO identity_key_pin (id, fingerprint) VALUES (2, '0123456789abcdef')`),
    ).rejects.toMatchObject({ code: '23514', constraint: 'ck_identity_key_pin_singleton' });
  });
});
