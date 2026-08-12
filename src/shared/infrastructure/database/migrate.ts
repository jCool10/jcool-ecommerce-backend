import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

// Programmatic migration runner so CI / Testcontainers can apply the same
// committed SQL migrations without the drizzle-kit CLI. Reads DATABASE_URL.
const MIGRATIONS_FOLDER = 'src/shared/infrastructure/database/migrations';

async function runMigrations(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is required to run migrations');
  }
  const pool = new Pool({ connectionString });
  try {
    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_FOLDER });
    console.log('Migrations applied.');
  } finally {
    await pool.end();
  }
}

void runMigrations().catch((error: unknown) => {
  console.error('Migration failed:', error);
  process.exit(1);
});
