import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BUCKET_COUNT, LAYOUT_VERSION, identityKeyFingerprint } from '@jcool/id-codec';
import { E2E_IDENTITY_BUCKET_KEY, bucketForTestEmail } from '../setup/identity.helper';
import { resetDatabase } from '../setup/reset-database';
import { createTestApp, inProcessIdGenerator } from '../setup/test-app.factory';
import { workerDatabaseUrl } from '../setup/worker-resources';

describe('Identity pin checked before the row canary (integration)', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: workerDatabaseUrl() });
  });

  afterAll(async () => {
    // The pin left behind would refuse the next file's boot in this worker.
    await resetDatabase(pool);
    await pool.end();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
  });

  // A build whose layout moved the bucket field reads every stored id as some other bucket, which the
  // canary alone would blame on the key.
  it('refuses a populated database pinned under another layout with the layout error', async () => {
    const email = 'boot-order-layout@test.local';
    const [elsewhere] = await inProcessIdGenerator.mint((bucketForTestEmail(email) + 1) % BUCKET_COUNT);
    await pool.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'not-a-real-hash')`, [
      elsewhere,
      email,
    ]);
    await pool.query(`INSERT INTO identity_key_pin (id, fingerprint, layout_version) VALUES (1, $1, $2)`, [
      identityKeyFingerprint(E2E_IDENTITY_BUCKET_KEY),
      LAYOUT_VERSION + 1,
    ]);

    await expect(createTestApp({ IDENTITY_PIN_BOOTSTRAP: 'true' })).rejects.toThrow(
      /id layout does not match the one this database was built with/,
    );
  });
});
