import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { bucketForEmail, identityKeyFingerprint } from '@shared/identity';
import { normalizeEmail } from '@shared/kernel/normalize-email';
import { createTestUser } from '../setup/fixtures/user.fixture';
import { E2E_IDENTITY_BUCKET_KEY, WRONG_IDENTITY_BUCKET_KEY } from '../setup/identity.helper';
import { resetDatabase } from '../setup/reset-database';
import { createTestApp } from '../setup/test-app.factory';

// Booting under the wrong key misfiles every id minted from then on, silently. The unit suite proves
// the guard's branches; this proves a real application boot reaches them.
describe('Identity bucket key boot guards (integration)', () => {
  let pool: Pool;

  const password = 'Password123!';

  // The address has to be one the two keys bucket differently, or the canary passes and the pin
  // raises a different error than the one under test.
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
    // The last test leaves a fingerprint from a key nothing else in the run uses, and every other
    // spec file boots its app ahead of its own truncate — so the next one would be refused at boot.
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

  // No rows to sample, so the canary cannot speak — the case the pin exists for.
  it('refuses to boot under a different key against an empty database', async () => {
    await (await createTestApp()).close();

    await expect(createTestApp({ IDENTITY_BUCKET_KEY: WRONG_IDENTITY_BUCKET_KEY })).rejects.toThrow(
      /does not match the key this database was built with/,
    );
  });

  // Ordering, not just detection: a pin recorded before the canary has spoken would hold every later
  // boot to the wrong key.
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

  // Fail open: no id is minted while the database is down, so failing closed adds an outage to an outage.
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

  // A second pinned fingerprint would mean two answers to which key built this database, and the
  // boot guard reads by primary key without noticing there were others.
  it('holds the pin to a single row', async () => {
    await pool.query(`INSERT INTO identity_key_pin (id, fingerprint) VALUES (1, 'deadbeefdeadbeef')`);

    await expect(
      pool.query(`INSERT INTO identity_key_pin (id, fingerprint) VALUES (2, '0123456789abcdef')`),
    ).rejects.toMatchObject({ code: '23514', constraint: 'ck_identity_key_pin_singleton' });
  });
});
