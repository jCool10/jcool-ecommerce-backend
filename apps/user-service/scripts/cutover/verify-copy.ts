/**
 * Proves the copy landed before anything is allowed to write again:
 *
 *   API_DATABASE_URL=… USER_DATABASE_URL=… IDENTITY_BUCKET_KEY=… \
 *     tsx scripts/cutover/verify-copy.ts [--reverse] [--epochs]
 *
 * Row counts and a content checksum per table on both sides, then the identity scan on the target.
 * `--epochs` adds the Redis comparison, which only means anything after prewarm-epochs.ts has run.
 * Exits non-zero on any disagreement.
 */
import { Redis } from 'ioredis';
import { Pool, type PoolClient } from 'pg';
import { SESSION_EPOCH_KEY_PREFIX } from '@jcool/auth-verifier';
import { verifyIdentityBuckets } from '../verify-identity-buckets';

const TABLES = ['users', 'email_verification_tokens', 'password_reset_tokens', 'refresh_tokens', 'identity_key_pin'];
const BATCH = 10_000;
const MISMATCHES_SHOWN = 20;
const SCAN_START = '00000000-0000-0000-0000-000000000000';

interface TableState {
  rows: number;
  checksum: string;
}

/**
 * jsonb sorts its keys, so this is the same digest on both sides however the columns are physically
 * ordered — which they are not, production having added two by ALTER. UTC because the session time
 * zone is what renders a timestamptz into that text.
 */
async function stateOf(client: PoolClient, table: string): Promise<TableState> {
  const { rows } = await client.query<{ rows: string; checksum: string | null }>(
    `SELECT count(*) AS rows, md5(coalesce(string_agg(to_jsonb(t)::text, '' ORDER BY t.id), '')) AS checksum
       FROM ${table} t`,
  );
  return { rows: Number(rows[0].rows), checksum: rows[0].checksum ?? '' };
}

async function utcClient(pool: Pool): Promise<PoolClient> {
  const client = await pool.connect();
  await client.query(`SET TimeZone='UTC'`);
  return client;
}

async function compareTables(source: Pool, target: Pool): Promise<boolean> {
  const [sourceClient, targetClient] = await Promise.all([utcClient(source), utcClient(target)]);
  try {
    let matched = true;
    for (const table of TABLES) {
      const [from, to] = await Promise.all([stateOf(sourceClient, table), stateOf(targetClient, table)]);
      const same = from.rows === to.rows && from.checksum === to.checksum;
      matched &&= same;
      console.log(
        same
          ? `  ${table}: ${to.rows} rows, checksum matches`
          : `  ${table}: MISMATCH — source ${from.rows} rows (${from.checksum}), target ${to.rows} rows (${to.checksum})`,
      );
    }
    return matched;
  } finally {
    sourceClient.release();
    targetClient.release();
  }
}

/**
 * Every user's epoch has to be in Redis before the api starts reading it there: a key that is merely
 * missing reads as "no revocation" unless something fills it, and a stale one lets a revoked session
 * back in. A key ahead of the database is fine — a bump during the window raised it.
 */
async function compareEpochs(target: Pool, redis: Redis): Promise<boolean> {
  let cursor = SCAN_START;
  let checked = 0;
  let missing = 0;
  let stale = 0;
  const shown: string[] = [];

  for (;;) {
    const { rows } = await target.query<{ id: string; token_epoch: number }>(
      `SELECT id, token_epoch FROM users WHERE id > $1 ORDER BY id LIMIT $2`,
      [cursor, BATCH],
    );
    if (rows.length === 0) break;

    const cached = await redis.mget(rows.map((row) => SESSION_EPOCH_KEY_PREFIX + row.id));
    rows.forEach((row, index) => {
      const value = cached[index];
      if (value === null) {
        missing++;
        if (shown.length < MISMATCHES_SHOWN) shown.push(`${row.id} missing`);
      } else if (Number(value) < row.token_epoch) {
        stale++;
        if (shown.length < MISMATCHES_SHOWN) shown.push(`${row.id} ${value} < ${row.token_epoch}`);
      }
    });
    checked += rows.length;
    cursor = rows[rows.length - 1].id;
  }

  console.log(`Epochs: ${checked} users, ${missing} missing, ${stale} behind the database.`);
  for (const line of shown) console.log(`  ${line}`);
  return missing === 0 && stale === 0;
}

async function main(): Promise<void> {
  const reverse = process.argv.includes('--reverse');
  const withEpochs = process.argv.includes('--epochs');
  const apiUrl = required('API_DATABASE_URL');
  const userUrl = required('USER_DATABASE_URL');
  const bucketKey = required('IDENTITY_BUCKET_KEY');

  const source = new Pool({ connectionString: reverse ? userUrl : apiUrl, max: 2 });
  const target = new Pool({ connectionString: reverse ? apiUrl : userUrl, max: 2 });
  const redis = withEpochs ? new Redis(required('REDIS_URL')) : undefined;

  try {
    console.log(`Comparing ${reverse ? 'user-service → api' : 'api → user-service'}:`);
    const tablesMatch = await compareTables(source, target);
    const identityOk = await verifyIdentityBuckets(target, bucketKey);
    const epochsOk = redis === undefined || (await compareEpochs(target, redis));

    if (!tablesMatch || !identityOk || !epochsOk) {
      console.error('Verification FAILED — do not open writes.');
      process.exitCode = 1;
      return;
    }
    console.log('Verification passed.');
  } finally {
    await Promise.all([source.end(), target.end(), redis?.quit()]);
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

void main().catch((error: unknown) => {
  console.error('Copy verification failed:', error);
  process.exit(1);
});
