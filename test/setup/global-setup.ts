import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer } from '@testcontainers/redis';
import { Client } from 'pg';
import { runMigrations } from '@shared/infrastructure/database/migrate';

const POSTGRES_IMAGE = 'postgres:16-alpine';
const REDIS_IMAGE = 'redis:7-alpine';

// Three owners, three databases, but one container: a second would double the ~10s startup and the
// memory for no extra isolation — separate databases in one Postgres share nothing a test can
// observe, not a schema, not a connection, not a transaction.
const USER_DATABASE = 'user_service';
const LEASE_DATABASE = 'node_leases';

const CORE_MIGRATIONS = 'apps/commerce-core/migrations';
const USER_MIGRATIONS = 'apps/user/migrations';
const LEASE_MIGRATIONS = 'libs/identity/src/lease/migrations';

declare module 'vitest' {
  interface ProvidedContext {
    DATABASE_URL: string;
    USER_DATABASE_URL: string;
    IDENTITY_LEASE_DATABASE_URL: string;
    REDIS_URL: string;
  }
}

async function createDatabases(adminUrl: string, names: readonly string[]): Promise<string[]> {
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    for (const name of names) {
      await client.query(`CREATE DATABASE "${name}"`);
    }
  } finally {
    await client.end();
  }
  return names.map((name) => {
    const url = new URL(adminUrl);
    url.pathname = `/${name}`;
    return url.toString();
  });
}

// Runs once per test:e2e in its own process; URLs reach workers via provide()/inject().
export default async function setup({
  provide,
}: {
  provide: (
    key: 'DATABASE_URL' | 'USER_DATABASE_URL' | 'IDENTITY_LEASE_DATABASE_URL' | 'REDIS_URL',
    value: string,
  ) => void;
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
    const [userDatabaseUrl, leaseDatabaseUrl] = await createDatabases(databaseUrl, [USER_DATABASE, LEASE_DATABASE]);
    const redisUrl = redis.getConnectionUrl();
    // Three journals, migrated independently — exactly as the three deploy steps do it.
    await runMigrations(databaseUrl, CORE_MIGRATIONS);
    await runMigrations(userDatabaseUrl, USER_MIGRATIONS);
    await runMigrations(leaseDatabaseUrl, LEASE_MIGRATIONS);
    provide('DATABASE_URL', databaseUrl);
    provide('USER_DATABASE_URL', userDatabaseUrl);
    provide('IDENTITY_LEASE_DATABASE_URL', leaseDatabaseUrl);
    provide('REDIS_URL', redisUrl);
  } catch (error) {
    await Promise.allSettled([postgres.stop(), redis.stop()]);
    throw error;
  }

  return async () => {
    await Promise.allSettled([postgres.stop(), redis.stop()]);
  };
}
