import 'dotenv/config';
import * as argon2 from 'argon2';
import { Pool } from 'pg';
import { IdentityService, UuidV8Generator } from '@shared/identity';
import { leaseNodeIdForScript } from '@shared/identity/lease/standalone-lease';
import { normalizeEmail, type NormalizedEmail } from '@shared/kernel/normalize-email';

// Grows `users` and its unique-email index to a target row count WITHOUT going through the API, so
// the benchmark can read index size / cache residency / autovacuum behavior at scale. Every row
// shares one email prefix, so `--clean` can never delete a real account.
//
// Batched multi-row INSERT rather than COPY, to avoid a pg-copy-streams dependency.
//
// Ids are written over raw SQL, so nothing in the type system ties these rows to the app's minting
// path — derive them the same way or the version-nibble CHECK on `users.id` rejects the batch.

const EMAIL_PREFIX = 'loadtest+';
const EMAIL_DOMAIN = 'loadtest.jcool.local';
// One shared hash: throwaway rows never log in, but the column must hold a real-length value or
// table/index size measurements are dishonest.
const SEED_PASSWORD = 'loadtest-throwaway-not-a-real-secret';

// Normalized at the source so the row's id, the unique index and `--clean` all see the same bytes.
function emailFor(i: number): NormalizedEmail {
  return normalizeEmail(`${EMAIL_PREFIX}${i}@${EMAIL_DOMAIN}`);
}

// A leased node id keeps a seed run from colliding with a live app on the (ts, node, seq) triple —
// from the `scripts` pool, so it can never narrow the fleet's. The key must be the app's own:
// seeding under another writes misrouted ids no query notices.
function identity(nodeId: number): { ids: IdentityService; generator: UuidV8Generator } {
  const bucketKey = process.env.IDENTITY_BUCKET_KEY;
  if (!bucketKey) throw new Error('IDENTITY_BUCKET_KEY is required to mint user ids');
  const generator = UuidV8Generator.create({ nodeId });
  return { ids: new IdentityService(generator, bucketKey), generator };
}

function intArg(name: string, fallback: number): number {
  const flag = process.argv.find((a) => a.startsWith(`--${name}=`));
  const raw = flag ? flag.split('=')[1] : process.env[name.toUpperCase()];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

async function insertBatch(pool: Pool, ids: IdentityService, hash: string, start: number, size: number): Promise<void> {
  const values: string[] = [];
  const params: unknown[] = [];
  for (let r = 0; r < size; r++) {
    const base = r * 3;
    values.push(`($${base + 1}, $${base + 2}, $${base + 3})`);
    const email = emailFor(start + r);
    params.push(ids.mintUserId(email), email, hash);
  }
  await pool.query(
    `INSERT INTO users (id, email, password_hash) VALUES ${values.join(',')} ON CONFLICT (email) DO NOTHING`,
    params,
  );
}

async function clean(pool: Pool): Promise<void> {
  const res = await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`${EMAIL_PREFIX}%`]);
  console.log(`Cleaned ${res.rowCount ?? 0} synthetic user rows (email LIKE '${EMAIL_PREFIX}%').`);
}

async function main(): Promise<void> {
  const connectionString = process.env.USER_DATABASE_URL;
  if (!connectionString) throw new Error('USER_DATABASE_URL is required to run the bulk seeder');
  if (process.env.NODE_ENV === 'production') {
    throw new Error('seed-users-bulk refuses to run with NODE_ENV=production (writes/deletes throwaway rows)');
  }

  const pool = new Pool({ connectionString, max: 4 });
  try {
    if (process.argv.includes('--clean')) {
      // Cleaning mints nothing, so it takes no node id — one held here would narrow the pool for a
      // concurrent run that does mint.
      await clean(pool);
      return;
    }

    const count = intArg('count', 200_000);
    const batch = Math.max(1, Math.min(intArg('batch', 2_000), 20_000)); // ×3 params stays under pg's 65535 cap
    const hash = await argon2.hash(SEED_PASSWORD);
    const lease = await leaseNodeIdForScript();
    // One generator for the whole run: a second would repeat this node's sequence values.
    const { ids, generator } = identity(lease.node);
    lease.attach(generator);

    try {
      await seed(pool, ids, hash, count, batch);
    } finally {
      await lease.release();
    }
  } finally {
    await pool.end();
  }
}

async function seed(pool: Pool, ids: IdentityService, hash: string, count: number, batch: number): Promise<void> {
  const startedAt = Date.now();
  let inserted = 0;
  for (let start = 0; start < count; start += batch) {
    const size = Math.min(batch, count - start);
    await insertBatch(pool, ids, hash, start, size);
    inserted += size;
    if (inserted % (batch * 20) === 0 || inserted === count) {
      const secs = (Date.now() - startedAt) / 1000;
      console.log(`  ${inserted}/${count} rows (${Math.round(inserted / Math.max(secs, 0.001))} rows/s)`);
    }
  }
  const secs = (Date.now() - startedAt) / 1000;
  console.log(
    `Bulk seed complete: ${inserted} synthetic users in ${secs.toFixed(1)}s ` +
      `(${Math.round(inserted / Math.max(secs, 0.001))} rows/s). Prefix '${EMAIL_PREFIX}', domain '${EMAIL_DOMAIN}'.`,
  );
  console.log(`Clean up later with: npm run seed:users:bulk -- --clean`);
}

void main().catch((error: unknown) => {
  console.error('Bulk seed failed:', error);
  process.exit(1);
});
