/**
 * Full scan of `users`, checking that every id routes to the bucket its email hashes to:
 *   pnpm identity:verify
 *
 * The boot canary samples one row; this reads all of them, answering what a sample cannot: does this
 * database agree with a freshly provisioned key, and how many rows did a drift hit. Only `users` —
 * token routing follows the owner's `user_id`, so a misrouted user is the whole finding. Exits
 * non-zero on disagreement so it can gate a deploy.
 */
import { Pool } from 'pg';
import { bucketForEmail, bucketOf } from '@jcool/id-codec';
import { normalizeEmail } from '@jcool/kernel';
import {
  type IdentityPin,
  identityPinMismatch,
  runningIdentityPin,
} from '../src/modules/user/infrastructure/identity-key-pin-comparison';

const BATCH = 10_000;
const OFFENDERS_SHOWN = 20;

interface UserRow {
  id: string;
  email: string;
}

// null means the value is not a routable id at all — bucketOf throws on those.
function carriedBucket(id: string): number | null {
  try {
    return bucketOf(id);
  } catch {
    return null;
  }
}

async function reportKeyPin(pool: Pool, running: IdentityPin): Promise<boolean> {
  const { rows } = await pool.query<IdentityPin>(
    `SELECT fingerprint, layout_version AS "layoutVersion" FROM identity_key_pin WHERE id = 1`,
  );
  const pinned = rows[0];
  if (pinned === undefined) {
    console.log(
      `Key fingerprint ${running.fingerprint}, id layout ${running.layoutVersion} (nothing pinned yet — a boot ` +
        `pins it only with IDENTITY_PIN_BOOTSTRAP=true)`,
    );
    return true;
  }
  const mismatch = identityPinMismatch(pinned, running);
  if (mismatch !== null) {
    console.error(mismatch);
    return false;
  }
  console.log(
    `Key fingerprint ${running.fingerprint} matches the one pinned in this database (id layout ${running.layoutVersion}).`,
  );
  return true;
}

// No lower bound on the first page: a zero or negative id is still read, and counted as misrouted.
function readPage(pool: Pool, after: string | null): Promise<{ rows: UserRow[] }> {
  return after === null
    ? pool.query<UserRow>(`SELECT id, email FROM users ORDER BY id LIMIT $1`, [BATCH])
    : pool.query<UserRow>(`SELECT id, email FROM users WHERE id > $1 ORDER BY id LIMIT $2`, [after, BATCH]);
}

/** The whole scan, printing as it goes: the pin check, then every row. False on any disagreement. */
export async function verifyIdentityBuckets(pool: Pool, bucketKey: string): Promise<boolean> {
  const pinMatches = await reportKeyPin(pool, runningIdentityPin(bucketKey));

  let cursor: string | null = null;
  let scanned = 0;
  let misrouted = 0;
  // Counted, not collected: under an outright wrong key every row is an offender, and holding
  // them all would exhaust the heap before printing.
  const shown: string[] = [];

  for (;;) {
    // Keyset paging: OFFSET re-reads every earlier page, and this has to stay usable at the row
    // counts that make the question worth asking.
    const { rows } = await readPage(pool, cursor);
    if (rows.length === 0) break;

    for (const row of rows) {
      if (carriedBucket(row.id) !== bucketForEmail(normalizeEmail(row.email), bucketKey)) {
        misrouted++;
        // Ids only: this output gets pasted into tickets.
        if (shown.length < OFFENDERS_SHOWN) shown.push(row.id);
      }
    }
    scanned += rows.length;
    cursor = rows[rows.length - 1].id;
    if (scanned % (BATCH * 10) === 0) console.log(`  ${scanned} rows scanned, ${misrouted} misrouted`);
  }

  console.log(`Scanned ${scanned} users: ${misrouted} misrouted.`);
  for (const id of shown) console.log(`  ${id}`);
  if (misrouted > shown.length) console.log(`  ... and ${misrouted - shown.length} more`);

  return pinMatches && misrouted === 0;
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required to verify identity buckets');
  const bucketKey = process.env.IDENTITY_BUCKET_KEY;
  if (!bucketKey) throw new Error('IDENTITY_BUCKET_KEY is required to verify identity buckets');

  const pool = new Pool({ connectionString, max: 2 });
  try {
    if (!(await verifyIdentityBuckets(pool, bucketKey))) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (process.argv[1]?.endsWith('verify-identity-buckets.ts')) {
  void main().catch((error: unknown) => {
    console.error('Identity bucket verification failed:', error);
    process.exit(1);
  });
}
