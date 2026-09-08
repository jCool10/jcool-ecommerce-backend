import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

// The default stays CWD-relative, which is what the repo root gives the test harness and
// drizzle-kit; the production image has no `src/` tree and sets MIGRATIONS_DIR to an absolute path.
// An env override rather than a directory expression: this file compiles to CJS for the app but is
// transformed to ESM under vitest, so neither __dirname nor import.meta works in both.
export const MIGRATIONS_FOLDER = process.env.MIGRATIONS_DIR ?? 'src/shared/infrastructure/database/migrations';

export async function runMigrations(connectionString = process.env.DATABASE_URL): Promise<void> {
  if (!connectionString) {
    throw new Error('DATABASE_URL is required to run migrations');
  }
  const pool = new Pool({ connectionString });
  // Without an 'error' listener a dead idle client crashes the process.
  pool.on('error', (err: Error) => console.error('Migration pool client error:', err.message));
  try {
    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await pool.end();
  }
}
