/**
 * Full scan of `users`, checking that every id routes to the bucket its email hashes to:
 *   npm run identity:verify
 *
 * The boot canary samples one row; this reads all of them — for the two questions the sample cannot
 * answer: does this database agree with a freshly provisioned key, and how many rows did a drift hit.
 *
 * Only `users`: token routing follows the owner's `user_id`, so a misrouted user is the whole finding.
 * Read-only, and exits non-zero on disagreement so it can gate a deploy.
 */
import 'dotenv/config';
import { Pool } from 'pg';
import { bucketForEmail, bucketOf, identityKeyFingerprint } from '../src/shared/identity';
import { normalizeEmail } from '../src/shared/kernel/normalize-email';

const BATCH = 10_000;
const OFFENDERS_SHOWN = 20;
// Sorts before every real id, so the first page starts at the beginning.
const SCAN_START = '00000000-0000-0000-0000-000000000000';

interface UserRow {
  id: string;
  email: string;
}

/** Bucket carried by the id, or null for any non-v8 id. */
function carriedBucket(id: string): number | null {
  try {
    return bucketOf(id);
  } catch {
    return null;
  }
}

async function reportKeyPin(pool: Pool, fingerprint: string): Promise<boolean> {
  const { rows } = await pool.query<{ fingerprint: string }>(`SELECT fingerprint FROM identity_key_pin WHERE id = 1`);
  const pinned = rows[0]?.fingerprint;
  if (pinned === undefined) {
    console.log(`Key fingerprint ${fingerprint} (nothing pinned yet — the next boot will pin whatever key it holds)`);
    return true;
  }
  if (pinned !== fingerprint) {
    console.error(`Key fingerprint ${fingerprint} does NOT match the pinned ${pinned} — this is the wrong key.`);
    return false;
  }
  console.log(`Key fingerprint ${fingerprint} matches the one pinned in this database.`);
  return true;
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required to verify identity buckets');
  const bucketKey = process.env.IDENTITY_BUCKET_KEY;
  if (!bucketKey) throw new Error('IDENTITY_BUCKET_KEY is required to verify identity buckets');

  const pool = new Pool({ connectionString, max: 2 });
  try {
    const keyMatches = await reportKeyPin(pool, identityKeyFingerprint(bucketKey));

    let cursor = SCAN_START;
    let scanned = 0;
    let misrouted = 0;
    // Counted, not collected: under an outright wrong key every row is an offender, and holding
    // them all would exhaust the heap before printing.
    const shown: string[] = [];

    for (;;) {
      // Keyset paging: OFFSET re-reads every earlier page, and this has to stay usable at the row
      // counts that make the question worth asking.
      const { rows } = await pool.query<UserRow>(`SELECT id, email FROM users WHERE id > $1 ORDER BY id LIMIT $2`, [
        cursor,
        BATCH,
      ]);
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

    if (misrouted > 0 || !keyMatches) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  console.error('Identity bucket verification failed:', error);
  process.exit(1);
});
