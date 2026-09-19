import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BUCKET_COUNT, bucketOf } from '@jcool/id-codec';
import { normalizeEmail } from '@jcool/kernel';
import { IdentityService } from '../../src/modules/user/application/services/identity.service';
import { E2E_IDENTITY_BUCKET_KEY, bucketForTestEmail } from '../setup/identity.helper';
import { resetDatabase } from '../setup/reset-database';
import { createTestApp } from '../setup/test-app.factory';
import { workerDatabaseUrl } from '../setup/worker-resources';

// Enough rows per bucket that a hot one stands out from noise; the hash itself is unit-tested.
const USERS = process.env.CI ? 50_000 : 100_000;
const INSERT_BATCH = 2_000;

const HOT_BUCKET_TOLERANCE = 3;
const MAX_UNUSED_BUCKET_RATIO = 0.01;

const execFileAsync = promisify(execFile);
// Specs compile as CommonJS (no `import.meta`); the runner always starts at the package root.
const packageRoot = process.cwd();
const SCAN_TIMEOUT_MS = 90_000;

describe('Identity colocation at scale (integration)', () => {
  let app: INestApplication;
  let pool: Pool;
  let rows: { id: string; email: string }[];

  const emailFor = (i: number) => `colocation-${i}@test.local`;

  function carriedBucket(id: string): number | null {
    try {
      return bucketOf(id);
    } catch {
      return null;
    }
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: workerDatabaseUrl() });
    // Before the boot, so the app pins its key on a database it is the first to touch.
    await resetDatabase(pool);
    app = await createTestApp({ IDENTITY_PIN_BOOTSTRAP: 'true' });

    const identity = app.get(IdentityService);
    for (let from = 0; from < USERS; from += INSERT_BATCH) {
      const size = Math.min(INSERT_BATCH, USERS - from);
      const values: string[] = [];
      const params: unknown[] = [];
      for (let i = 0; i < size; i++) {
        const email = normalizeEmail(emailFor(from + i));
        values.push(`($${i * 2 + 1}, $${i * 2 + 2}, 'not-a-real-hash')`);
        params.push(await identity.mintUserId(email), email);
      }
      await pool.query(`INSERT INTO users (id, email, password_hash) VALUES ${values.join(',')}`, params);
    }

    rows = (await pool.query<{ id: string; email: string }>(`SELECT id, email FROM users`)).rows;
  });

  afterAll(async () => {
    await app.close();
    // Six figures of rows would slow every later truncate in this worker.
    await resetDatabase(pool);
    await pool.end();
  });

  it('routes every stored id to the bucket its address hashes to', () => {
    expect(rows).toHaveLength(USERS);

    const misrouted = rows.filter((row) => carriedBucket(row.id) !== bucketForTestEmail(row.email));

    // Capped first: a wrong key misroutes every row, and printing them all buries the failure.
    expect(misrouted.slice(0, 5)).toEqual([]);
    expect(misrouted).toHaveLength(0);
  });

  it('spreads addresses across the bucket space with no hot bucket', () => {
    const counts = new Array<number>(BUCKET_COUNT).fill(0);
    for (const row of rows) {
      const bucket = carriedBucket(row.id);
      if (bucket !== null) counts[bucket]++;
    }

    const share = USERS / BUCKET_COUNT;
    const unused = counts.filter((count) => count === 0).length;

    expect(Math.max(...counts)).toBeLessThan(share * HOT_BUCKET_TOLERANCE);
    expect(unused / BUCKET_COUNT).toBeLessThan(MAX_UNUSED_BUCKET_RATIO);
  });

  // Pages the whole table on the primary key, so this also proves the paging reads every row once.
  it(
    'passes the operator scan over every row',
    async () => {
      const stdout = await runOperatorScan();

      expect(stdout).toContain('matches the one pinned in this database');
      expect(stdout).toContain(`Scanned ${USERS} users: 0 misrouted.`);
    },
    SCAN_TIMEOUT_MS * 2,
  );

  // `execFile` moves stdout onto the error on a non-zero exit; surface it instead of a bare "exit 1".
  async function runOperatorScan(): Promise<string> {
    try {
      const { stdout } = await execFileAsync(
        join(packageRoot, 'node_modules/.bin/tsx'),
        ['scripts/verify-identity-buckets.ts'],
        {
          cwd: packageRoot,
          timeout: SCAN_TIMEOUT_MS,
          env: {
            ...process.env,
            DATABASE_URL: workerDatabaseUrl(),
            IDENTITY_BUCKET_KEY: E2E_IDENTITY_BUCKET_KEY,
          },
        },
      );
      return stdout;
    } catch (error) {
      const { stdout = '', stderr = '' } = error as { stdout?: string; stderr?: string };
      throw new Error(`verify-identity-buckets exited non-zero\n${stdout}\n${stderr}`, { cause: error });
    }
  }
});
