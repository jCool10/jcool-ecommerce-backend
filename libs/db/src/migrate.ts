import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

// The default stays CWD-relative, which is what the repo root gives the test harness and
// drizzle-kit; the production image has no source tree and sets MIGRATIONS_DIR to an absolute path.
// An env override rather than a directory expression: this file compiles to CJS for the app but is
// transformed to ESM under vitest, so neither __dirname nor import.meta works in both.
// One variable per journal: the two apps migrate independently and neither may name the other's.
export const MIGRATIONS_FOLDER = process.env.MIGRATIONS_DIR ?? 'apps/commerce-core/migrations';
export const USER_MIGRATIONS_FOLDER = process.env.USER_MIGRATIONS_DIR ?? 'apps/user/migrations';

// The folder is a parameter as well as an env var: the e2e harness migrates both journals in one
// process, where a single MIGRATIONS_DIR could only name one of them.
export async function runMigrations(
  connectionString = process.env.DATABASE_URL,
  migrationsFolder = MIGRATIONS_FOLDER,
): Promise<void> {
  if (!connectionString) {
    throw new Error('DATABASE_URL is required to run migrations');
  }
  const pool = new Pool({ connectionString });
  // Without an 'error' listener a dead idle client crashes the process.
  pool.on('error', (err: Error) => console.error('Migration pool client error:', err.message));
  try {
    await migrate(drizzle(pool), { migrationsFolder });
  } finally {
    await pool.end();
  }
}
