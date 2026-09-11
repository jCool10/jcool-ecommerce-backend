import type { Pool } from 'pg';

// Drizzle's migration ledger lives in the `drizzle` schema, so truncating `public` keeps the
// migrated structure. Postgres only — Redis is not flushed here, so a Redis-backed feature needing
// per-test isolation must reset its own keys.
//
// Correct under file parallelism without change: each worker owns its own database
// (test/setup/worker-resources.ts), so a TRUNCATE reaches only that worker's rows.
//
// Measured alternative, deliberately not taken: DROP + CREATE from the template is ~2.9x cheaper
// (75ms vs 215ms), but Postgres refuses to drop a database any session still holds — and every test
// here runs with the app's pool open. It is therefore a per-file operation at best, not the per-test
// one this is, and the bookkeeping to close and rebuild a pool between files costs more than 140ms.
export async function resetDatabase(pool: Pool): Promise<void> {
  const { rows } = await pool.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
  );
  if (rows.length === 0) return;

  const tables = rows.map((r) => `"${r.tablename}"`).join(', ');
  await pool.query(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`);
}
