import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

// Programmatic migration runner (no drizzle-kit CLI) for CI / Testcontainers.
// Pure module — no self-execution — so global-setup can import runMigrations().
// Folder is relative to the process CWD (repo root).
const MIGRATIONS_FOLDER = 'src/shared/infrastructure/database/migrations';

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
