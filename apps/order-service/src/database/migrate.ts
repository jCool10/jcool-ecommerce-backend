import { readdirSync } from 'node:fs';
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

// A wrong path that still resolves to a readable directory makes drizzle report zero pending
// migrations and exit 0: a green deploy on an empty schema.
function countSqlFiles(folder: string): number {
  try {
    return readdirSync(folder).filter((name) => name.endsWith('.sql')).length;
  } catch {
    return 0;
  }
}

export interface MigrateForDeployOptions {
  connectionString?: string;
  migrationsFolder?: string;
  log?: Pick<Console, 'log' | 'error'>;
}

/** The exit code of a deploy-time migration, which refuses a folder with no .sql file in it. */
export async function migrateForDeploy({
  connectionString = process.env.DATABASE_URL,
  migrationsFolder = MIGRATIONS_FOLDER,
  log = console,
}: MigrateForDeployOptions = {}): Promise<number> {
  const sqlCount = countSqlFiles(migrationsFolder);
  if (sqlCount === 0) {
    log.error(`no .sql migrations found in ${migrationsFolder}`);
    return 1;
  }
  try {
    await runMigrations(connectionString, migrationsFolder);
  } catch (error) {
    log.error('migration failed:', error instanceof Error ? (error.stack ?? error.message) : String(error));
    return 1;
  }
  log.log(`migrations up to date from ${migrationsFolder} (${sqlCount} files)`);
  return 0;
}
