import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer } from '@testcontainers/redis';
import { runMigrations } from '../../src/shared/infrastructure/database/migrate';

const POSTGRES_IMAGE = 'postgres:16-alpine';
const REDIS_IMAGE = 'redis:7-alpine';

declare module 'vitest' {
  interface ProvidedContext {
    DATABASE_URL: string;
    REDIS_URL: string;
  }
}

// Runs once per test:e2e in its own process; URLs reach workers via provide()/inject().
export default async function setup({
  provide,
}: {
  provide: (key: 'DATABASE_URL' | 'REDIS_URL', value: string) => void;
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
    const redisUrl = redis.getConnectionUrl();
    await runMigrations(databaseUrl);
    provide('DATABASE_URL', databaseUrl);
    provide('REDIS_URL', redisUrl);
  } catch (error) {
    await Promise.allSettled([postgres.stop(), redis.stop()]);
    throw error;
  }

  return async () => {
    await Promise.allSettled([postgres.stop(), redis.stop()]);
  };
}
