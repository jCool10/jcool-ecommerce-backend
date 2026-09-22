import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LAYOUT_VERSION, identityKeyFingerprint } from '@jcool/id-codec';
import { SCRIPTS_NODE_ID, SnowflakeGenerator } from '@jcool/id-generator';
import { E2E_IDENTITY_BUCKET_KEY, WRONG_IDENTITY_BUCKET_KEY, bucketForTestEmail } from '../setup/identity.helper';
import { resetDatabase } from '../setup/reset-database';
import { workerDatabaseUrl } from '../setup/worker-resources';

const execFileAsync = promisify(execFile);
// Specs compile as CommonJS (no `import.meta`); the runner always starts at the package root.
const packageRoot = process.cwd();
const SCAN_TIMEOUT_MS = 60_000;

interface ScanResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// `pnpm identity:verify` as a deploy gate sees it: the script's own process and its exit code.
describe('Operator identity scan (integration)', () => {
  let pool: Pool;

  async function runOperatorScan(): Promise<ScanResult> {
    try {
      const { stdout, stderr } = await execFileAsync(
        join(packageRoot, 'node_modules/.bin/tsx'),
        ['scripts/verify-identity-buckets.ts'],
        {
          cwd: packageRoot,
          timeout: SCAN_TIMEOUT_MS,
          env: { ...process.env, DATABASE_URL: workerDatabaseUrl(), IDENTITY_BUCKET_KEY: E2E_IDENTITY_BUCKET_KEY },
        },
      );
      return { exitCode: 0, stdout, stderr };
    } catch (error) {
      const { code, stdout = '', stderr = '' } = error as { code?: unknown; stdout?: string; stderr?: string };
      if (typeof code !== 'number') throw error;
      return { exitCode: code, stdout, stderr };
    }
  }

  const pin = (key: string, layoutVersion: number) =>
    pool.query(`INSERT INTO identity_key_pin (id, fingerprint, layout_version) VALUES (1, $1, $2)`, [
      identityKeyFingerprint(key),
      layoutVersion,
    ]);

  const insertUser = (id: string, email: string) =>
    pool.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'not-a-real-hash')`, [id, email]);

  beforeAll(() => {
    pool = new Pool({ connectionString: workerDatabaseUrl() });
  });

  afterAll(async () => {
    await resetDatabase(pool);
    await pool.end();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
  });

  it('passes a database pinned under the running key and layout', async () => {
    await pin(E2E_IDENTITY_BUCKET_KEY, LAYOUT_VERSION);

    const scan = await runOperatorScan();

    expect(scan.exitCode).toBe(0);
    expect(scan.stdout).toContain(`matches the one pinned in this database (id layout ${LAYOUT_VERSION})`);
    expect(scan.stdout).toContain('Scanned 0 users: 0 misrouted.');
  });

  // No rows for the scan to disagree with: the pin is the whole verdict, and the boot refuses this.
  it('fails an empty database pinned under another id layout', async () => {
    await pin(E2E_IDENTITY_BUCKET_KEY, LAYOUT_VERSION + 1);

    const scan = await runOperatorScan();

    expect(scan.exitCode).toBe(1);
    expect(scan.stderr).toContain(
      `id layout does not match the one this database was built with (pinned ${LAYOUT_VERSION + 1}, current ${LAYOUT_VERSION})`,
    );
    expect(scan.stdout).not.toContain('matches the one pinned');
  });

  it('fails an empty database pinned under another key', async () => {
    await pin(WRONG_IDENTITY_BUCKET_KEY, LAYOUT_VERSION);

    const scan = await runOperatorScan();

    expect(scan.exitCode).toBe(1);
    expect(scan.stderr).toContain('IDENTITY_BUCKET_KEY does not match the key this database was built with');
  });

  // The CHECK keeps these out today; the scan must still see them in a database that predates it.
  it('counts zero, negative and too-small ids as misrouted', async () => {
    const email = 'operator-scan-routed@test.local';
    const routed = SnowflakeGenerator.create({ nodeId: SCRIPTS_NODE_ID }).generate(bucketForTestEmail(email));

    await pool.query(`ALTER TABLE users DROP CONSTRAINT ck_users_id_routable`);
    try {
      await insertUser(routed, email);
      for (const id of ['-1', '0', '4194303']) await insertUser(id, `operator-scan-${id}@test.local`);

      const scan = await runOperatorScan();

      expect(scan.exitCode).toBe(1);
      expect(scan.stdout).toContain('Scanned 4 users: 3 misrouted.');
      expect(scan.stdout).toMatch(/^ {2}-1\n {2}0\n {2}4194303$/m);
    } finally {
      await pool.query(`DELETE FROM users WHERE id < 4194304`);
      await pool.query(`ALTER TABLE users ADD CONSTRAINT ck_users_id_routable CHECK (id >= 4194304)`);
    }
  });
});
