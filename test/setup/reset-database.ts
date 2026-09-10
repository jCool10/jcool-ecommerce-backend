import type { Pool } from 'pg';

// Drizzle's migration ledger lives in the `drizzle` schema, so truncating `public` keeps the
// migrated structure. Postgres only — Redis is not flushed here, so a Redis-backed feature needing
// per-test isolation must reset its own keys.
//
// Takes a pool rather than a URL so it truncates whichever database that pool is bound to: a core
// app's pool clears commerce tables, a user app's clears the five identity ones. A suite running
// both apps resets both, in whatever order it holds them — nothing spans the two.
export async function resetDatabase(pool: Pool): Promise<void> {
  const { rows } = await pool.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
  );
  if (rows.length === 0) return;

  const tables = rows.map((r) => `"${r.tablename}"`).join(', ');
  await pool.query(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`);
}
