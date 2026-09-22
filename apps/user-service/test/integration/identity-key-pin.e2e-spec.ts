import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bucketForEmail, identityKeyFingerprint } from '@jcool/id-codec';
import { normalizeEmail } from '@jcool/kernel';
import { createTestUser } from '../setup/fixtures/user.fixture';
import { resetDatabaseBeforeEach } from '../setup/harness';
import { E2E_IDENTITY_BUCKET_KEY, WRONG_IDENTITY_BUCKET_KEY } from '../setup/identity.helper';
import { resetDatabase } from '../setup/reset-database';
import { createTestApp } from '../setup/test-app.factory';
import { workerDatabaseUrl } from '../setup/worker-resources';

// Each boot is the subject: the guard runs at startup, so every case needs its own key and database.
describe('Identity bucket key boot guards (integration)', () => {
  let pool: Pool;

  const password = 'Password123!';

  const boot = (env: Record<string, string> = {}): Promise<INestApplication> =>
    createTestApp({ IDENTITY_PIN_BOOTSTRAP: 'true', ...env });

  // Must route differently under the two keys, or the canary passes and the pin raises instead.
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
    pool = new Pool({ connectionString: workerDatabaseUrl() });
  });

  afterAll(async () => {
    // A leftover wrong-key pin would refuse the next file's boot in this worker.
    await resetDatabase(pool);
    await pool.end();
  });

  resetDatabaseBeforeEach(() => pool);

  it('pins the running key the first time it boots against a database', async () => {
    const app = await boot();
    try {
      const { rows } = await pool.query<{ fingerprint: string }>(`SELECT fingerprint FROM identity_key_pin`);

      expect(rows).toEqual([{ fingerprint: identityKeyFingerprint(E2E_IDENTITY_BUCKET_KEY) }]);
    } finally {
      await app.close();
    }
  });

  // No rows for the canary to sample: the case the pin exists for.
  it('refuses to boot under a different key against an empty database', async () => {
    await (await boot()).close();

    await expect(boot({ IDENTITY_BUCKET_KEY: WRONG_IDENTITY_BUCKET_KEY })).rejects.toThrow(
      /does not match the key this database was built with/,
    );
  });

  // A pin recorded before the canary spoke would hold every later boot to the wrong key.
  it('refuses on a misrouted row without pinning the key that found it', async () => {
    const first = await boot();
    await createTestUser(first, { email: addressTheKeysDisagreeAbout() });
    await first.close();
    await pool.query(`DELETE FROM identity_key_pin`);

    await expect(boot({ IDENTITY_BUCKET_KEY: WRONG_IDENTITY_BUCKET_KEY })).rejects.toThrow(
      /does not route to the bucket its email hashes to/,
    );

    const { rows } = await pool.query(`SELECT 1 FROM identity_key_pin`);
    expect(rows).toHaveLength(0);
  });

  // Fail open: failing closed on an unreadable pin adds an outage to an outage.
  it('boots and mints when the pin cannot be read at all', async () => {
    // Renamed, not dropped: later files in this worker share the database.
    await pool.query(`ALTER TABLE identity_key_pin RENAME TO identity_key_pin_unreachable`);
    try {
      const app = await boot();
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

  it('holds the pin to a single row', async () => {
    await pool.query(`INSERT INTO identity_key_pin (id, fingerprint) VALUES (1, 'deadbeefdeadbeef')`);

    await expect(
      pool.query(`INSERT INTO identity_key_pin (id, fingerprint) VALUES (2, '0123456789abcdef')`),
    ).rejects.toMatchObject({ code: '23514', constraint: 'ck_identity_key_pin_singleton' });
  });
});
