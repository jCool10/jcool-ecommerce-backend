import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer } from '@testcontainers/redis';
import { Client } from 'pg';
import { runMigrations } from '../../src/shared/infrastructure/database/migrate';
import {
  MAX_REDIS_DB_INDEX,
  TEMPLATE_DATABASE,
  withDatabase,
  workerCount,
  workerDatabaseName,
} from './worker-resources';

const POSTGRES_IMAGE = 'postgres:16-alpine';
const REDIS_IMAGE = 'redis:7-alpine';

// Postgres 16 ships max_connections=100, which four workers can reach. No spec holds more than two
// apps open at once (`queue-connection.e2e-spec.ts`; the identity-key-pin files boot apps one at a
// time and close each in a `finally`), so the realistic peak is 2 apps × DB_POOL_MAX × workers plus
// a handful of raw pools — around 100 at W=4. Raised to 300 so that peak sits well inside the limit
// and a file that boots more apps later fails on its own pool rather than on the server's global one.
const MAX_CONNECTIONS = 300;

declare module 'vitest' {
  interface ProvidedContext {
    /** The container's own database. Worker URLs are derived from it; nothing connects to it directly. */
    PG_BASE_URL: string;
    /** No logical-db index — each worker appends its own. */
    REDIS_BASE_URL: string;
  }
}

// Runs once per test:e2e in its own process; URLs reach workers via provide()/inject(), which is
// run-global — the per-worker scoping is applied worker-side in worker-resources.ts.
export default async function setup({
  provide,
}: {
  provide: (key: 'PG_BASE_URL' | 'REDIS_BASE_URL', value: string) => void;
}): Promise<() => Promise<void>> {
  // Before any `docker run`: the Redis cap is knowable here, and `assertWorkerBudget` can only
  // report it per worker, i.e. after both containers are up, the template is migrated and N
  // databases are cloned — minutes of setup to reach a config error we can see now. `workerCount()`
  // also throws here on a malformed E2E_WORKERS, which is the earliest point anything reads it.
  if (workerCount() > MAX_REDIS_DB_INDEX) {
    throw new Error(
      `E2E_WORKERS=${workerCount()} exceeds Redis's ${MAX_REDIS_DB_INDEX + 1} logical databases. ` +
        `Cap it at ${MAX_REDIS_DB_INDEX}; beyond that, workers would share a Redis db and ` +
        `cache/idempotency/throttle keys would collide silently.`,
    );
  }

  // allSettled, not Promise.all: a one-sided failure must still expose the container that did
  // start, or it is orphaned.
  const [pgResult, redisResult] = await Promise.allSettled([
    new PostgreSqlContainer(POSTGRES_IMAGE)
      .withCommand(['postgres', '-c', `max_connections=${MAX_CONNECTIONS}`])
      .start(),
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
    const baseUrl = postgres.getConnectionUri();
    await createWorkerDatabases(baseUrl);
    provide('PG_BASE_URL', baseUrl);
    provide('REDIS_BASE_URL', redis.getConnectionUrl());
  } catch (error) {
    await Promise.allSettled([postgres.stop(), redis.stop()]);
    throw error;
  }

  return async () => {
    // Dropping the container drops every worker database with it.
    await Promise.allSettled([postgres.stop(), redis.stop()]);
  };
}

/**
 * Migrate once into a template, then clone it per worker (~96ms each) instead of migrating N times
 * (~1.0s each). Cloning happens here rather than in each worker so it is sequential and ordered:
 * concurrent clones of one template are harder to reason about than a loop that has already finished
 * before the first spec file loads.
 */
async function createWorkerDatabases(baseUrl: string): Promise<void> {
  // Connected to the container's own database, never to the template: `CREATE DATABASE ... TEMPLATE`
  // is refused while any session holds the source. runMigrations releases its pool (migrate.ts:21).
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
