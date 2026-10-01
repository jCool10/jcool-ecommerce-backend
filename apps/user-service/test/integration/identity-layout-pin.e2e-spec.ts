import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LAYOUT_VERSION } from '@jcool/id-codec';
import { createTestUser } from '../setup/fixtures/user.fixture';
import { resetDatabaseBeforeEach } from '../setup/harness';
import { resetDatabase } from '../setup/reset-database';
import { createTestApp } from '../setup/test-app.factory';
import { workerDatabaseUrl } from '../setup/worker-resources';

// Each boot is the subject: the guard runs at startup, so every case needs its own database.
describe('Id layout pin boot guard (integration)', () => {
  let pool: Pool;

  const password = 'Password123!';

  const boot = (env: Record<string, string> = {}): Promise<INestApplication> =>
    createTestApp({ IDENTITY_PIN_BOOTSTRAP: 'true', ...env });

  const pinnedLayouts = async (): Promise<number[]> => {
    const { rows } = await pool.query<{ layout_version: number }>(`SELECT layout_version FROM identity_key_pin`);
    return rows.map((row) => row.layout_version);
  };

  beforeAll(() => {
    pool = new Pool({ connectionString: workerDatabaseUrl() });
  });

  afterAll(async () => {
    // A leftover foreign-layout pin would refuse the next file's boot in this worker.
    await resetDatabase(pool);
    await pool.end();
  });

  resetDatabaseBeforeEach(() => pool);

  it('pins the running layout the first time it boots against an empty database', async () => {
    const app = await boot();
    try {
      expect(await pinnedLayouts()).toEqual([LAYOUT_VERSION]);
    } finally {
      await app.close();
    }
  });

  it('refuses to boot on a database pinned under another layout', async () => {
    await pool.query(`INSERT INTO identity_key_pin (id, layout_version) VALUES (1, $1)`, [LAYOUT_VERSION - 1]);

    await expect(boot()).rejects.toThrow(/id layout does not match the one this database was built with/);
  });

  // Those users were minted under a layout nothing recorded, so the running one is not written as a guess.
  it('leaves a database that already holds users unpinned', async () => {
    const first = await boot();
    await createTestUser(first);
    await first.close();
    await pool.query(`DELETE FROM identity_key_pin`);

    await (await boot()).close();

    expect(await pinnedLayouts()).toEqual([]);
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
          .send({ email: 'layout-pin-fail-open@test.local', password })
          .expect(201);
      } finally {
        await app.close();
      }
    } finally {
      await pool.query(`ALTER TABLE identity_key_pin_unreachable RENAME TO identity_key_pin`);
    }
  });

  it('holds the pin to a single row', async () => {
    await pool.query(`INSERT INTO identity_key_pin (id) VALUES (1)`);

    await expect(pool.query(`INSERT INTO identity_key_pin (id) VALUES (2)`)).rejects.toMatchObject({
      code: '23514',
      constraint: 'ck_identity_key_pin_singleton',
    });
  });
});
