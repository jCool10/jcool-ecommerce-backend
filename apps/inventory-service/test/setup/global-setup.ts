import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer } from '@testcontainers/redis';
import { Client } from 'pg';
import { runMigrations } from '../../src/database/migrate';
import {
  MAX_REDIS_DB_INDEX,
  TEMPLATE_DATABASE,
  withDatabase,
  workerCount,
  workerDatabaseName,
} from './worker-resources';

const POSTGRES_IMAGE = 'postgres:16-alpine';
export const REDIS_IMAGE = 'redis:7-alpine';
const MAX_CONNECTIONS = 300;

declare module 'vitest' {
  interface ProvidedContext {
    PG_BASE_URL: string;
    /** No logical-db index; each worker appends its own. */
    REDIS_BASE_URL: string;
  }
}

export default async function setup({
  provide,
}: {
  provide: (key: 'PG_BASE_URL' | 'REDIS_BASE_URL', value: string) => void;
}): Promise<() => Promise<void>> {
  if (workerCount() > MAX_REDIS_DB_INDEX) {
    throw new Error(`E2E_WORKERS=${workerCount()} exceeds Redis's ${MAX_REDIS_DB_INDEX + 1} logical databases.`);
  }

  // allSettled so a one-sided failure still stops the container that did start.
  const [pgResult, redisResult] = await Promise.allSettled([
    new PostgreSqlContainer(POSTGRES_IMAGE)
      .withCommand(['postgres', '-c', `max_connections=${MAX_CONNECTIONS}`])
      .start(),
    // The app refuses a Redis that would lose `auth:epoch:*` on restart.
    new RedisContainer(REDIS_IMAGE).withCommand(['redis-server', '--appendonly', 'yes']).start(),
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
    const baseUrl = postgres.getConnectionUri();
    await createWorkerDatabases(baseUrl);
    provide('PG_BASE_URL', baseUrl);
    provide('REDIS_BASE_URL', redis.getConnectionUrl());
  } catch (error) {
    await Promise.allSettled([postgres.stop(), redis.stop()]);
    throw error;
  }

  return async () => {
    await Promise.allSettled([postgres.stop(), redis.stop()]);
  };
}

// Migrate once, clone per worker. The admin connection never touches the template: CREATE ... TEMPLATE
// is refused while any session holds the source.
async function createWorkerDatabases(baseUrl: string): Promise<void> {
  const admin = new Client({ connectionString: baseUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${TEMPLATE_DATABASE}"`);
    await runMigrations(withDatabase(baseUrl, TEMPLATE_DATABASE));
    for (let workerId = 1; workerId <= workerCount(); workerId += 1) {
      await admin.query(`CREATE DATABASE "${workerDatabaseName(workerId)}" TEMPLATE "${TEMPLATE_DATABASE}"`);
    }
  } finally {
    await admin.end();
  }
}
