import 'dotenv/config';
import * as argon2 from 'argon2';
import { Pool } from 'pg';
import { v7 as uuidv7 } from 'uuid';

// Bulk throwaway-user seeder for the register-uniqueness benchmark harness.
// Grows the `users` table + its unique-email index to a target row count WITHOUT
// going through the API, so the benchmark can read index size / cache residency /
// autovacuum behavior at scale. Every row shares one email prefix so `--clean`
// can delete only synthetic rows and never a real account.
//
// Bulk path = batched multi-row INSERT (no pg-copy-streams dependency). Fast
// enough for the smoke/≤1M scales actually run under the <100M target. For the
// gated 10M–100M decisive runs, swap `insertBatch` for `COPY users (...) FROM
// STDIN` (add pg-copy-streams) — the tuple generator already emits COPY-ready
// rows. See plans/260817-1035-email-uniqueness-at-scale/phase-03-*.md.

const EMAIL_PREFIX = 'loadtest+';
const EMAIL_DOMAIN = 'loadtest.jcool.local';
// One shared, realistic-width argon2id hash: throwaway rows never log in, but the
// column should hold a real-length value so table/index size measurements are honest.
const SEED_PASSWORD = 'loadtest-throwaway-not-a-real-secret';

/** Normalized (already lowercase/trimmed) synthetic email for row `i`. */
function emailFor(i: number): string {
  return `${EMAIL_PREFIX}${i}@${EMAIL_DOMAIN}`;
}

function intArg(name: string, fallback: number): number {
  const flag = process.argv.find((a) => a.startsWith(`--${name}=`));
  const raw = flag ? flag.split('=')[1] : process.env[name.toUpperCase()];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

async function insertBatch(pool: Pool, hash: string, start: number, size: number): Promise<void> {
  const values: string[] = [];
  const params: unknown[] = [];
  for (let r = 0; r < size; r++) {
    const base = r * 3;
    values.push(`($${base + 1}, $${base + 2}, $${base + 3})`);
    params.push(uuidv7(), emailFor(start + r), hash);
  }
  // ON CONFLICT makes a re-run idempotent (resumes/top-ups rather than erroring).
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
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required to run the bulk seeder');
  // Destructive throwaway tooling (bulk INSERT + `--clean` DELETE): refuse to touch a
  // production DB even if DATABASE_URL is mispointed.
  if (process.env.NODE_ENV === 'production') {
    throw new Error('seed-users-bulk refuses to run with NODE_ENV=production (writes/deletes throwaway rows)');
  }

  const pool = new Pool({ connectionString, max: 4 });
  try {
    if (process.argv.includes('--clean')) {
      await clean(pool);
      return;
    }

    const count = intArg('count', 200_000);
    const batch = Math.max(1, Math.min(intArg('batch', 2_000), 20_000)); // clamp 1..20000; ×3 params < pg's 65535 cap
    const hash = await argon2.hash(SEED_PASSWORD);

    const startedAt = Date.now();
    let inserted = 0;
    for (let start = 0; start < count; start += batch) {
      const size = Math.min(batch, count - start);
      await insertBatch(pool, hash, start, size);
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
  } finally {
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  console.error('Bulk seed failed:', error);
  process.exit(1);
});
