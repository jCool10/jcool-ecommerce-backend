import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { BUCKET_COUNT, IdentityService, bucketOf } from '../../src/shared/identity';
import { normalizeEmail } from '../../src/shared/kernel/normalize-email';
import { E2E_IDENTITY_BUCKET_KEY, bucketForTestEmail } from '../setup/identity.helper';
import { resetDatabase } from '../setup/reset-database';
import { createTestApp } from '../setup/test-app.factory';

// Full locally, reduced on CI. Both sizes keep the expected count per bucket well above the handful
// below which "one bucket is hot" stops being distinguishable from noise; the 1M-sample verdict on
// the hash itself belongs to the unit suite, where a sample costs nothing. Here a sample is a row.
const USERS = process.env.CI ? 50_000 : 100_000;
const INSERT_BATCH = 2_000;

// A bucket holding this many times its share would be a shard that fills before its neighbours.
const HOT_BUCKET_TOLERANCE = 3;
// Buckets no address reached. A key that spread unevenly would leave dead zones as well as hot ones.
const MAX_UNUSED_BUCKET_RATIO = 0.01;

const execFileAsync = promisify(execFile);
// Resolved from the working directory rather than from this file: specs typecheck as CommonJS, where
// `import.meta` is a compile error. `npm run test:e2e` always starts the runner at the package root.
const repoRoot = process.cwd();
const SCAN_TIMEOUT_MS = 90_000;

// One id per row, minted the way the app mints it and read back out of Postgres, because the claim
// is about what the shard map will find — not about what the hash returned in memory.
describe('Identity colocation at scale (integration)', () => {
  let app: INestApplication;
  let pool: Pool;
  let rows: { id: string; email: string }[];

  const emailFor = (i: number) => `colocation-${i}@test.local`;

  /** The bucket an id carries, or null when it carries none — the shape a misrouted row would have. */
  function carriedBucket(id: string): number | null {
    try {
      return bucketOf(id);
    } catch {
      return null;
    }
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: inject('DATABASE_URL') });
    // Before the app boots, so it pins its key against a database it is the first to touch — the
    // operator scan below reads that pin.
    await resetDatabase(pool);
    app = await createTestApp();

    const identity = app.get(IdentityService);
    for (let from = 0; from < USERS; from += INSERT_BATCH) {
      const size = Math.min(INSERT_BATCH, USERS - from);
      const values: string[] = [];
      const params: unknown[] = [];
      for (let i = 0; i < size; i++) {
        const email = normalizeEmail(emailFor(from + i));
        values.push(`($${i * 2 + 1}, $${i * 2 + 2}, 'not-a-real-hash')`);
        params.push(identity.mintUserId(email), email);
      }
      await pool.query(`INSERT INTO users (id, email, password_hash) VALUES ${values.join(',')}`, params);
    }

    rows = (await pool.query<{ id: string; email: string }>(`SELECT id, email FROM users`)).rows;
  });

  afterAll(async () => {
    await app.close();
    // These rows are minted, not fixtures: leaving six figures of them behind would slow every
    // truncate and every sequential scan for the rest of the run.
    await resetDatabase(pool);
    await pool.end();
  });

  it('routes every stored id to the bucket its address hashes to', () => {
    expect(rows).toHaveLength(USERS);

    const misrouted = rows.filter((row) => carriedBucket(row.id) !== bucketForTestEmail(row.email));

    // Capped before the length assertion: a wrong key misroutes every row, and printing them all
    // would bury the run in output before the failure is readable.
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

  // The tool an operator runs after provisioning a key, and the only automated cover it has. It
  // pages the whole table on the primary key rather than sampling, so this is also the assertion
  // that the paging terminates and reads every row exactly once.
  it(
    'passes the operator scan over every row',
    async () => {
      const stdout = await runOperatorScan();

      expect(stdout).toContain('matches the one pinned in this database');
      expect(stdout).toContain(`Scanned ${USERS} users: 0 misrouted.`);
    },
    SCAN_TIMEOUT_MS * 2,
  );

  // The scan reports misrouted rows on stdout, which `execFile` moves onto the rejection instead of
  // returning once the exit code is non-zero — so without this a real finding surfaces as "exit 1".
  async function runOperatorScan(): Promise<string> {
    try {
      const { stdout } = await execFileAsync(
        join(repoRoot, 'node_modules/.bin/tsx'),
        ['scripts/verify-identity-buckets.ts'],
        {
          cwd: repoRoot,
          // Under the test's own timeout, so a scan that stops paging is killed here and reports what
          // it had read rather than dying anonymously with the rest of the file.
          timeout: SCAN_TIMEOUT_MS,
          env: {
            ...process.env,
            DATABASE_URL: inject('DATABASE_URL'),
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
