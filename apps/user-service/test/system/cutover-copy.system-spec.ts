import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Redis } from 'ioredis';
import { Pool } from 'pg';
import { GenericContainer, Network, type StartedNetwork, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SESSION_EPOCH_KEY_PREFIX } from '@jcool/auth-verifier';
import { bucketForEmail, bucketOf, identityKeyFingerprint } from '@jcool/id-codec';
import { SCRIPTS_NODE_ID, UuidV8Generator } from '@jcool/id-generator';
import { normalizeEmail } from '@jcool/kernel';

const execFileAsync = promisify(execFile);

const PACKAGE_ROOT = resolve(__dirname, '../..');
const API_MIGRATIONS = resolve(PACKAGE_ROOT, '../api/src/shared/infrastructure/database/migrations');
const USER_MIGRATIONS = resolve(PACKAGE_ROOT, 'src/database/migrations');
const COPY_SCRIPT = resolve(PACKAGE_ROOT, 'scripts/cutover/copy-user-tables.sh');
const PG_PORT = 5432;
const BUCKET_KEY = randomBytes(24).toString('hex');
const USERS = 5;
const SCRIPT_TIMEOUT_MS = 120_000;

interface SeededUser {
  id: string;
  email: string;
  refreshTokenId: string;
  resetTokenId: string;
}

const generator = UuidV8Generator.create({ nodeId: SCRIPTS_NODE_ID });
const mintForEmail = (email: string) => generator.generate(bucketForEmail(normalizeEmail(email), BUCKET_KEY));
const mintOwnedBy = (userId: string) => generator.generate(bucketOf(userId));

/**
 * The cutover scripts against the two databases they will really see: the api's carries the whole
 * migration chain (so `users` has the physical column order that ALTER left behind), the
 * user-service's only its baseline.
 */
describe('cutover: copying the user tables', () => {
  let network: StartedNetwork;
  let apiPg: StartedTestContainer;
  let userPg: StartedTestContainer;
  let redisContainer: StartedTestContainer;
  let api: Pool;
  let user: Pool;
  let redis: Redis;
  let scriptEnv: Record<string, string>;
  let seeded: SeededUser[];

  beforeAll(async () => {
    network = await new Network().start();
    [apiPg, userPg, redisContainer] = await Promise.all([
      startPostgres('api-postgres', 'api'),
      // The copy runs where psql is, on the network the two databases share.
      startPostgres('user-postgres', 'users', [{ source: COPY_SCRIPT, target: '/copy-user-tables.sh', mode: 0o755 }]),
      new GenericContainer('redis:7-alpine')
        .withNetwork(network)
        .withCommand(['redis-server', '--appendonly', 'yes'])
        .withExposedPorts(6379)
        .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
        .start(),
    ]);

    api = new Pool({ connectionString: hostUrl(apiPg, 'api'), max: 4 });
    user = new Pool({ connectionString: hostUrl(userPg, 'users'), max: 4 });
    redis = new Redis(`redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`);
    scriptEnv = {
      API_DATABASE_URL: hostUrl(apiPg, 'api'),
      USER_DATABASE_URL: hostUrl(userPg, 'users'),
      REDIS_URL: `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`,
      IDENTITY_BUCKET_KEY: BUCKET_KEY,
    };

    await migrate(drizzle(api), { migrationsFolder: API_MIGRATIONS });
    await migrate(drizzle(user), { migrationsFolder: USER_MIGRATIONS });
    seeded = await seedApi();
  }, 600_000);

  afterAll(async () => {
    await Promise.allSettled([api?.end(), user?.end(), redis?.quit()]);
    await Promise.allSettled([apiPg, userPg, redisContainer].map((container) => container?.stop({ timeout: 0 })));
    await network?.stop();
  });

  function startPostgres(
    alias: string,
    name: string,
    files: { source: string; target: string; mode?: number }[] = [],
  ): Promise<StartedTestContainer> {
    return new GenericContainer('postgres:16-alpine')
      .withNetwork(network)
      .withNetworkAliases(alias)
      .withEnvironment({ POSTGRES_USER: name, POSTGRES_PASSWORD: name, POSTGRES_DB: name })
      .withExposedPorts(PG_PORT)
      .withCopyFilesToContainer(files)
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .start();
  }

  const hostUrl = (container: StartedTestContainer, name: string) =>
    `postgres://${name}:${name}@${container.getHost()}:${container.getMappedPort(PG_PORT)}/${name}`;

  async function seedApi(): Promise<SeededUser[]> {
    await api.query(`INSERT INTO identity_key_pin (id, fingerprint) VALUES (1, $1)`, [
      identityKeyFingerprint(BUCKET_KEY),
    ]);

    const users: SeededUser[] = [];
    for (let i = 0; i < USERS; i++) {
      const email = `cutover-${i}@example.test`;
      const id = mintForEmail(email);
      await api.query(
        `INSERT INTO users (id, email, password_hash, role, email_verified_at, token_epoch)
         VALUES ($1, $2, 'not-a-real-hash', $3, $4, $5)`,
        [id, email, i === 0 ? 'ADMIN' : 'CUSTOMER', i % 2 === 0 ? new Date() : null, i],
      );
      await api.query(
        `INSERT INTO email_verification_tokens (id, user_id, token_hash, expires_at)
         VALUES ($1, $2, $3, now() + interval '1 day')`,
        [mintOwnedBy(id), id, `verify-${i}`],
      );
      const resetTokenId = mintOwnedBy(id);
      await api.query(
        `INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at)
         VALUES ($1, $2, $3, now() + interval '1 hour')`,
        [resetTokenId, id, `reset-${i}`],
      );
      const refreshTokenId = mintOwnedBy(id);
      await api.query(
        `INSERT INTO refresh_tokens (id, user_id, token_hash, family_id, expires_at)
         VALUES ($1, $2, $3, $4, now() + interval '7 days')`,
        [refreshTokenId, id, `refresh-${i}`, randomUUID()],
      );
      // A row from another context, keyed by a user id without a foreign key to it.
      await api.query(`INSERT INTO carts (id, user_id) VALUES ($1, $2)`, [randomUUID(), id]);
      users.push({ id, email, refreshTokenId, resetTokenId });
    }
    return users;
  }

  async function runCopy(...args: string[]): Promise<string> {
    const { exitCode, output } = await userPg.exec([
      'sh',
      '-c',
      `API_DATABASE_URL='postgres://api:api@api-postgres:5432/api' ` +
        `USER_DATABASE_URL='postgres://users:users@user-postgres:5432/users' ` +
        `sh /copy-user-tables.sh ${args.join(' ')}`,
    ]);
    if (exitCode !== 0) throw new Error(`copy-user-tables.sh exited ${exitCode}\n${output}`);
    return output;
  }

  async function runScript(script: string, args: string[] = []): Promise<{ stdout: string; exitCode: number }> {
    try {
      const { stdout } = await execFileAsync(join(PACKAGE_ROOT, 'node_modules/.bin/tsx'), [script, ...args], {
        cwd: PACKAGE_ROOT,
        timeout: SCRIPT_TIMEOUT_MS,
        env: { ...process.env, ...scriptEnv },
      });
      return { stdout, exitCode: 0 };
    } catch (error) {
      const { stdout = '', code } = error as { stdout?: string; code?: number };
      if (typeof code !== 'number') throw error;
      return { stdout, exitCode: code };
    }
  }

  const verify = (args: string[] = []) => runScript('scripts/cutover/verify-copy.ts', args);

  const physicalColumns = async (pool: Pool, table: string): Promise<string[]> => {
    const { rows } = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
      [table],
    );
    return rows.map((row) => row.column_name);
  };

  it('starts from the mismatch production has: the same columns in a different physical order', async () => {
    const [fromApi, fromUserService] = await Promise.all([
      physicalColumns(api, 'users'),
      physicalColumns(user, 'users'),
    ]);

    expect(fromApi).not.toEqual(fromUserService);
    expect([...fromApi].sort()).toEqual([...fromUserService].sort());
  });

  it('copies every row, and the checksums agree across that mismatch', async () => {
    await runCopy();

    const { stdout, exitCode } = await verify();
    expect(stdout, stdout).toContain(`users: ${USERS} rows, checksum matches`);
    expect(stdout).toContain(`Scanned ${USERS} users: 0 misrouted.`);
    expect(exitCode).toBe(0);
  });

  it("replaces a pin a dark boot left behind with the api's", async () => {
    const { rows } = await user.query<{ fingerprint: string }>(`SELECT fingerprint FROM identity_key_pin`);

    expect(rows).toEqual([{ fingerprint: identityKeyFingerprint(BUCKET_KEY) }]);
  });

  it('keeps the foreign keys and the unique indexes', async () => {
    await expect(
      user.query(
        `INSERT INTO refresh_tokens (id, user_id, token_hash, family_id, expires_at)
         VALUES ($1, $2, 'orphan', $3, now())`,
        [mintOwnedBy(seeded[0].id), randomUUID(), randomUUID()],
      ),
    ).rejects.toThrow(/foreign key/);

    await expect(
      user.query(
        `INSERT INTO refresh_tokens (id, user_id, token_hash, family_id, expires_at)
         VALUES ($1, $2, 'refresh-0', $3, now())`,
        [mintOwnedBy(seeded[0].id), seeded[0].id, randomUUID()],
      ),
    ).rejects.toThrow(/duplicate key/);
  });

  it('refuses a copy that lost a value, and passes again once it is back', async () => {
    await user.query(`UPDATE users SET email = 'drifted@example.test' WHERE id = $1`, [seeded[1].id]);

    const drifted = await verify();
    expect(drifted.exitCode).toBe(1);
    expect(drifted.stdout).toContain('users: MISMATCH');

    await user.query(`UPDATE users SET email = $2 WHERE id = $1`, [seeded[1].id, seeded[1].email]);
    expect((await verify()).exitCode).toBe(0);
  });

  it('prewarms one epoch per user, at the value in the database', async () => {
    const { stdout } = await runScript('scripts/cutover/prewarm-epochs.ts');

    expect(stdout).toContain(`Prewarmed ${USERS} epochs.`);
    expect(await redis.keys(`${SESSION_EPOCH_KEY_PREFIX}*`)).toHaveLength(USERS);
    expect(await redis.get(SESSION_EPOCH_KEY_PREFIX + seeded[3].id)).toBe('3');
    expect((await verify(['--epochs'])).exitCode).toBe(0);
  });

  it('catches an epoch Redis never got, and one it has behind the database', async () => {
    await redis.del(SESSION_EPOCH_KEY_PREFIX + seeded[2].id);
    await redis.set(SESSION_EPOCH_KEY_PREFIX + seeded[4].id, '0');

    const { stdout, exitCode } = await verify(['--epochs']);

    expect(stdout).toContain('1 missing, 1 behind the database');
    expect(exitCode).toBe(1);
  });

  // The reason the rollback copies whole tables: what changes after the flip is mostly columns
  // being set in place, which nothing outside the row can see.
  describe('rolling back after a soak on the user-service', () => {
    let rotatedTokenId: string;
    let newUserId: string;

    beforeAll(async () => {
      // Rotation: the presented token is revoked and points at its successor.
      rotatedTokenId = mintOwnedBy(seeded[0].id);
      const { rows } = await user.query<{ family_id: string }>(
        `INSERT INTO refresh_tokens (id, user_id, token_hash, family_id, expires_at)
         SELECT $1, user_id, 'refresh-0-rotated', family_id, now() + interval '7 days'
           FROM refresh_tokens WHERE id = $2 RETURNING family_id`,
        [rotatedTokenId, seeded[0].refreshTokenId],
      );
      expect(rows).toHaveLength(1);
      await user.query(`UPDATE refresh_tokens SET revoked_at = now(), replaced_by_token_id = $2 WHERE id = $1`, [
        seeded[0].refreshTokenId,
        rotatedTokenId,
      ]);
      // Logout-all: the epoch moves and the family is revoked.
      await user.query(`UPDATE users SET token_epoch = token_epoch + 1 WHERE id = $1`, [seeded[1].id]);
      await user.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1`, [seeded[1].id]);
      // A reset link spent on the user-service.
      await user.query(`UPDATE password_reset_tokens SET consumed_at = now() WHERE id = $1`, [seeded[2].resetTokenId]);
      // And someone who only ever existed there.
      const email = 'registered-during-soak@example.test';
      newUserId = mintForEmail(email);
      await user.query(
        `INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, 'not-a-real-hash', 'CUSTOMER')`,
        [newUserId, email],
      );
    });

    it('carries every in-place change back to the api', async () => {
      await runCopy('--reverse');

      const { exitCode, stdout } = await verify(['--reverse']);
      expect(stdout, stdout).toContain(`users: ${USERS + 1} rows, checksum matches`);
      expect(exitCode).toBe(0);

      const revoked = await api.query<{ revoked_at: Date | null; replaced_by_token_id: string | null }>(
        `SELECT revoked_at, replaced_by_token_id FROM refresh_tokens WHERE id = $1`,
        [seeded[0].refreshTokenId],
      );
      expect(revoked.rows[0].revoked_at).not.toBeNull();
      expect(revoked.rows[0].replaced_by_token_id).toBe(rotatedTokenId);

      const epoch = await api.query<{ token_epoch: number }>(`SELECT token_epoch FROM users WHERE id = $1`, [
        seeded[1].id,
      ]);
      expect(epoch.rows[0].token_epoch).toBe(2);

      const consumed = await api.query<{ consumed_at: Date | null }>(
        `SELECT consumed_at FROM password_reset_tokens WHERE id = $1`,
        [seeded[2].resetTokenId],
      );
      expect(consumed.rows[0].consumed_at).not.toBeNull();

      const registered = await api.query(`SELECT 1 FROM users WHERE id = $1`, [newUserId]);
      expect(registered.rowCount).toBe(1);
    });

    it('leaves the rest of the api alone: TRUNCATE CASCADE stops at the user tables', async () => {
      const { rows } = await api.query<{ count: string }>(`SELECT count(*) AS count FROM carts`);

      expect(rows[0].count).toBe(String(USERS));
    });
  });
});
