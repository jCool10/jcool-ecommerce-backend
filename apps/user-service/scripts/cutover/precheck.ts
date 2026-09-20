/**
 * The gate in front of the cutover: everything that has to be true before writes are frozen.
 *
 *   API_DATABASE_URL=… USER_DATABASE_URL=… REDIS_URL=… API_URL=… GATEWAY_URL=… \
 *     USER_SERVICE_URL=… ID_SERVICE_URL=… INTERNAL_API_TOKEN=… CSRF_SECRET=… \
 *     tsx scripts/cutover/precheck.ts
 *
 * Only fingerprints of the secrets are compared: a mismatch means ids route to the wrong bucket or
 * CSRF cookies stop validating. Exits non-zero on the first thing that would make the copy unsafe,
 * and prints the manual checks it cannot make itself.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Redis } from 'ioredis';
import { Pool } from 'pg';
import { decode, identityKeyFingerprint } from '@jcool/id-codec';

const execFileAsync = promisify(execFile);

const TABLES = ['users', 'email_verification_tokens', 'password_reset_tokens', 'refresh_tokens', 'identity_key_pin'];
const MIN_PSQL_MAJOR = 16;
const MIN_ID_SERVICE_REPLICAS = 3;
const ID_PROBE_COUNT = 30;
const MEMORY_HEADROOM = 0.8;

interface Digest {
  identityBucketKey: string;
  csrfSecret: string;
}

const failures: string[] = [];

function check(passed: boolean, label: string, detail = ''): boolean {
  console.log(`${passed ? 'ok  ' : 'FAIL'} ${label}${detail && !passed ? ` — ${detail}` : ''}`);
  if (!passed) failures.push(label);
  return passed;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function checkPsql(): Promise<void> {
  try {
    const { stdout } = await execFileAsync('psql', ['--version']);
    const major = Number(/(\d+)/.exec(stdout)?.[1]);
    check(major >= MIN_PSQL_MAJOR, `psql is ${MIN_PSQL_MAJOR} or newer`, stdout.trim());
  } catch {
    check(false, `psql is ${MIN_PSQL_MAJOR} or newer`, 'psql is not on PATH');
  }
}

async function checkHealth(label: string, url: string, path: string): Promise<void> {
  try {
    const response = await fetch(new URL(path, url), { signal: AbortSignal.timeout(5_000) });
    check(response.ok, `${label} is ready`, `${path} answered ${response.status}`);
  } catch (error) {
    check(false, `${label} is ready`, String(error));
  }
}

/**
 * Every id carries the node that minted it, so a spread of ids is the only reading of the fleet a
 * caller can take: the load balancer hides which replica answered, and a replica without a lease
 * answers 503 rather than a wrong id.
 */
async function checkIdServiceFleet(url: string): Promise<void> {
  const nodes = new Set<number>();
  try {
    for (let i = 0; i < ID_PROBE_COUNT; i++) {
      const response = await fetch(new URL('/v1/ids', url), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-caller': 'cutover-precheck' },
        body: JSON.stringify({ bucket: 0, count: 1 }),
        signal: AbortSignal.timeout(2_000),
      });
      if (!response.ok) continue;
      const { ids } = (await response.json()) as { ids: string[] };
      nodes.add(decode(ids[0]).nodeId);
    }
  } catch (error) {
    check(false, `id-service has ${MIN_ID_SERVICE_REPLICAS} replicas minting`, String(error));
    return;
  }
  check(
    nodes.size >= MIN_ID_SERVICE_REPLICAS,
    `id-service has ${MIN_ID_SERVICE_REPLICAS} replicas minting`,
    `${ID_PROBE_COUNT} ids came from ${nodes.size} node(s)`,
  );
}

/** By column name, never by position: the two databases reached today's columns by different routes. */
async function checkSchemas(api: Pool, user: Pool): Promise<void> {
  const columnsOf = async (pool: Pool) => {
    const { rows } = await pool.query<{ shape: string }>(
      `SELECT table_name || '.' || column_name || ' ' || data_type || ' ' || is_nullable AS shape
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ANY($1)
        ORDER BY table_name, column_name`,
      [TABLES],
    );
    return rows.map((row) => row.shape);
  };

  const [apiColumns, userColumns] = await Promise.all([columnsOf(api), columnsOf(user)]);
  const onlyApi = apiColumns.filter((column) => !userColumns.includes(column));
  const onlyUser = userColumns.filter((column) => !apiColumns.includes(column));

  check(apiColumns.length > 0, 'the api has the five user tables', 'information_schema returned nothing');
  check(
    onlyApi.length === 0 && onlyUser.length === 0,
    'both databases describe the same five tables',
    `api only: ${onlyApi.join(', ')} | user-service only: ${onlyUser.join(', ')}`,
  );
}

async function checkTargetIsEmpty(user: Pool): Promise<void> {
  const { rows } = await user.query<{ count: string }>(`SELECT count(*) AS count FROM users`);
  check(rows[0].count === '0', 'the user-service database holds no users yet', `${rows[0].count} rows would collide`);
}

/** The key the deployed process actually loaded, not the one someone believes it was given. */
async function checkDigest(api: Pool, userServiceUrl: string, token: string): Promise<void> {
  let digest: Digest;
  try {
    const response = await fetch(new URL('/internal/v1/cutover/digest', userServiceUrl), {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`answered ${response.status}`);
    digest = (await response.json()) as Digest;
  } catch (error) {
    check(false, 'the user-service reports its key fingerprints', String(error));
    return;
  }

  const { rows } = await api.query<{ fingerprint: string }>(`SELECT fingerprint FROM identity_key_pin WHERE id = 1`);
  const pinned = rows[0]?.fingerprint;
  check(
    pinned !== undefined && digest.identityBucketKey === pinned,
    "the user-service holds the api's identity bucket key",
    `pinned ${pinned ?? 'nothing'}, user-service has ${digest.identityBucketKey}`,
  );

  check(
    digest.csrfSecret === identityKeyFingerprint(required('CSRF_SECRET')),
    'CSRF cookies already in circulation stay valid',
  );
}

/**
 * Instance-wide settings, so they are the same for the catalog cache and the queues. An evicted
 * epoch lets a revoked session back in, and a lost denylist entry revives a logged-out token.
 */
async function checkRedis(redis: Redis): Promise<void> {
  const memory = await redis.info('memory');
  const persistence = await redis.info('persistence');
  const field = (info: string, name: string) => new RegExp(`^${name}:(.*)$`, 'm').exec(info)?.[1]?.trim() ?? '';

  check(field(memory, 'maxmemory_policy') === 'noeviction', 'Redis evicts nothing', field(memory, 'maxmemory_policy'));
  check(field(persistence, 'aof_enabled') === '1', 'Redis appends to disk');

  const maxMemory = Number(field(memory, 'maxmemory'));
  const used = Number(field(memory, 'used_memory'));
  check(
    maxMemory === 0 || used / maxMemory < MEMORY_HEADROOM,
    `Redis is below ${MEMORY_HEADROOM * 100}% of its limit`,
    `${used} of ${maxMemory} bytes`,
  );
}

async function main(): Promise<void> {
  // Read before any check runs: a missing one is an operator mistake, not a red gate.
  const userServiceUrl = required('USER_SERVICE_URL');
  const internalToken = required('INTERNAL_API_TOKEN');
  required('CSRF_SECRET');

  const api = new Pool({ connectionString: required('API_DATABASE_URL'), max: 2 });
  const user = new Pool({ connectionString: required('USER_DATABASE_URL'), max: 2 });
  const redis = new Redis(required('REDIS_URL'));

  try {
    await checkPsql();
    await checkHealth('the api', required('API_URL'), '/health/ready');
    await checkHealth('the gateway', required('GATEWAY_URL'), '/health/live');
    await checkHealth('the user-service', userServiceUrl, '/health/ready');
    // Only from inside the private network: nothing publishes the load balancer.
    if (process.env.ID_SERVICE_URL) await checkIdServiceFleet(process.env.ID_SERVICE_URL);
    else console.log('skip the id-service fleet — ID_SERVICE_URL unset; check the replica count in Railway');
    await checkSchemas(api, user);
    await checkTargetIsEmpty(user);
    await checkDigest(api, userServiceUrl, internalToken);
    await checkRedis(redis);
  } finally {
    await Promise.all([api.end(), user.end(), redis.quit()]);
  }

  console.log('\nStill to confirm by hand (see RUNBOOK.md):');
  console.log('  - the api runs the build that accepts user-service tokens, with AUTH_JWKS_URL set');
  console.log('  - a backup of both databases exists, with its checksum recorded');
  console.log('  - the retention sweeps are off on both sides');

  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed — do not start the cutover.`);
    process.exitCode = 1;
    return;
  }
  console.log('\nPrecheck passed.');
}

void main().catch((error: unknown) => {
  console.error('Precheck failed:', error);
  process.exit(1);
});
