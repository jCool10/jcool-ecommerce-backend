import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { decode, encode } from '@jcool/id-codec';
import { SCRIPTS_NODE_ID } from '@jcool/id-generator';
import { E2E_IDENTITY_BUCKET_KEY, bucketForTestEmail } from '../setup/identity.helper';
import { resetDatabase } from '../setup/reset-database';
import { workerDatabaseUrl } from '../setup/worker-resources';

const execFileAsync = promisify(execFile);
// Specs compile as CommonJS (no `import.meta`); the runner always starts at the package root.
const packageRoot = process.cwd();
const SCRIPT_TIMEOUT_MS = 60_000;
// Further ahead than a script takes to boot, so an id stamped from the clock alone lands below it.
const EARLIER_RUN_AHEAD_MS = 5_000;

// Each script runs as the operator runs it, against a table where an earlier run on a host whose
// clock was ahead has already minted on the scripts node.
describe('Seed scripts mint above the newest id on their node (integration)', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: workerDatabaseUrl() });
  });
  beforeEach(() => resetDatabase(pool));
  afterAll(async () => {
    await resetDatabase(pool);
    await pool.end();
  });

  // An older run's row is planted first, so a floor read from any row but the newest lands below the newest.
  async function plantEarlierRunUsers(): Promise<number> {
    const newestMs = Date.now() + EARLIER_RUN_AHEAD_MS;
    const runs = [
      { email: 'older-run@test.local', tsMs: Date.now() - 60_000 },
      { email: 'earlier-run@test.local', tsMs: newestMs },
    ];
    for (const { email, tsMs } of runs) {
      const id = encode({ tsMs, bucket: bucketForTestEmail(email), nodeId: SCRIPTS_NODE_ID, sequence: 0 });
      await pool.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'not-a-real-hash')`, [id, email]);
    }
    return newestMs;
  }

  async function runScript(script: string, args: string[] = []): Promise<void> {
    try {
      await execFileAsync(join(packageRoot, 'node_modules/.bin/tsx'), [join('scripts', script), ...args], {
        cwd: packageRoot,
        timeout: SCRIPT_TIMEOUT_MS,
        env: { ...process.env, DATABASE_URL: workerDatabaseUrl(), IDENTITY_BUCKET_KEY: E2E_IDENTITY_BUCKET_KEY },
      });
    } catch (error) {
      const { stdout = '', stderr = '' } = error as { stdout?: string; stderr?: string };
      throw new Error(`${script} exited non-zero\n${stdout}\n${stderr}`, { cause: error });
    }
  }

  async function mintedTimestamps(emailLike: string): Promise<number[]> {
    const { rows } = await pool.query<{ id: string }>(`SELECT id FROM users WHERE email LIKE $1`, [emailLike]);
    return rows.map((row) => decode(row.id).tsMs);
  }

  it(
    'seeds bulk users above it, including the batches minted while an insert runs',
    async () => {
      const earlierRunMs = await plantEarlierRunUsers();

      await runScript('seed-users-bulk.ts', ['--count=250', '--batch=100']);

      const stamps = await mintedTimestamps('loadtest+%');
      expect(stamps).toHaveLength(250);
      expect(Math.min(...stamps)).toBeGreaterThan(earlierRunMs);
    },
    SCRIPT_TIMEOUT_MS,
  );

  it(
    'seeds the perf user above it',
    async () => {
      const earlierRunMs = await plantEarlierRunUsers();

      await runScript('seed-perf-user.ts');

      const stamps = await mintedTimestamps('perf@loadtest.jcool.local');
      expect(stamps).toHaveLength(1);
      expect(stamps[0]).toBeGreaterThan(earlierRunMs);
    },
    SCRIPT_TIMEOUT_MS,
  );
});
