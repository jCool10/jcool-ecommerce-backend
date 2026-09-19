import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

// CWD-relative by default, which the app directory gives drizzle-kit and the test harness; the image
// has no src/ tree and sets MIGRATIONS_DIR to an absolute path.
export const MIGRATIONS_FOLDER = process.env.MIGRATIONS_DIR ?? 'src/database/migrations';

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
