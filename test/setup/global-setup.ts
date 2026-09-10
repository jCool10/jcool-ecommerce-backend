import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer } from '@testcontainers/redis';
import { Client } from 'pg';
import { runMigrations } from '@shared/infrastructure/database/migrate';

const POSTGRES_IMAGE = 'postgres:16-alpine';
const REDIS_IMAGE = 'redis:7-alpine';

// The two services own separate databases, but a second container would double the ~10s startup
// and the memory for no extra isolation: separate databases in one Postgres share nothing a test
// can observe — not a schema, not a connection, not a transaction.
const USER_DATABASE = 'user_service';

const CORE_MIGRATIONS = 'apps/commerce-core/migrations';
const USER_MIGRATIONS = 'apps/user/migrations';

declare module 'vitest' {
  interface ProvidedContext {
    DATABASE_URL: string;
    USER_DATABASE_URL: string;
    REDIS_URL: string;
  }
}

async function createUserDatabase(adminUrl: string): Promise<string> {
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query(`CREATE DATABASE "${USER_DATABASE}"`);
  } finally {
    await client.end();
  }
  const url = new URL(adminUrl);
  url.pathname = `/${USER_DATABASE}`;
  return url.toString();
}

// Runs once per test:e2e in its own process; URLs reach workers via provide()/inject().
export default async function setup({
  provide,
}: {
  provide: (key: 'DATABASE_URL' | 'USER_DATABASE_URL' | 'REDIS_URL', value: string) => void;
}): Promise<() => Promise<void>> {
  // allSettled, not Promise.all: a one-sided failure must still expose the container that did
  // start, or it is orphaned.
  const [pgResult, redisResult] = await Promise.allSettled([
    new PostgreSqlContainer(POSTGRES_IMAGE).start(),
    new RedisContainer(REDIS_IMAGE).start(),
  ]);

  if (pgResult.status === 'rejected' || redisResult.status === 'rejected') {
    await Promise.allSettled([
      pgResult.status === 'fulfilled' ? pgResult.value.stop() : undefined,
      redisResult.status === 'fulfilled' ? redisResult.value.stop() : undefined,
    ]);
    if (pgResult.status === 'rejected') throw pgResult.reason;
    if (redisResult.status === 'rejected') throw redisResult.reason;
  }

  const postgres = pgResult.value;
  const redis = redisResult.value;

  try {
    const databaseUrl = postgres.getConnectionUri();
    const userDatabaseUrl = await createUserDatabase(databaseUrl);
    const redisUrl = redis.getConnectionUrl();
    // Two journals, migrated independently — exactly as the two deploy steps do it.
    await runMigrations(databaseUrl, CORE_MIGRATIONS);
    await runMigrations(userDatabaseUrl, USER_MIGRATIONS);
    provide('DATABASE_URL', databaseUrl);
    provide('USER_DATABASE_URL', userDatabaseUrl);
    provide('REDIS_URL', redisUrl);
  } catch (error) {
    await Promise.allSettled([postgres.stop(), redis.stop()]);
    throw error;
  }

  return async () => {
    await Promise.allSettled([postgres.stop(), redis.stop()]);
  };
}
