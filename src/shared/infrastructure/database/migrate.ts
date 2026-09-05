import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

// Programmatic migration runner (no drizzle-kit CLI) for CI / Testcontainers; pure module
// (no self-execution) so global-setup can import runMigrations(). The default stays CWD-relative,
// which is what the repo root gives test harness and drizzle-kit; the production image has no
// `src/` tree and sets MIGRATIONS_DIR to an absolute path instead.
// An env override rather than a directory expression: this file compiles to CJS for the app but is
// transformed to ESM under vitest, so neither __dirname nor import.meta works in both.
export const MIGRATIONS_FOLDER = process.env.MIGRATIONS_DIR ?? 'src/shared/infrastructure/database/migrations';

// Defaults to DATABASE_URL; tests pass the container connection string.
export async function runMigrations(connectionString = process.env.DATABASE_URL): Promise<void> {
  if (!connectionString) {
    throw new Error('DATABASE_URL is required to run migrations');
  }
  const pool = new Pool({ connectionString });
  // 'error' listener (parity with DrizzleModule) — an idle-client error would else crash the process.
  pool.on('error', (err: Error) => console.error('Migration pool client error:', err.message));
  try {
    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await pool.end();
  }
}
