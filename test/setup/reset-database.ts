import type { Pool } from 'pg';

// Truncate all public tables between tests. Drizzle's migration ledger lives in
// the `drizzle` schema, so the migrated structure survives. Scope is Postgres
// only — Redis is not flushed here; a future Redis-backed feature (cache,
// rate-limit) needing per-test isolation must reset its own keys.
export async function resetDatabase(pool: Pool): Promise<void> {
  const { rows } = await pool.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
  );
  if (rows.length === 0) return;

  const tables = rows.map((r) => `"${r.tablename}"`).join(', ');
  await pool.query(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`);
}
