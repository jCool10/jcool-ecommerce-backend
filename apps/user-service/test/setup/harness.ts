import type { INestApplication } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import { afterAll, beforeEach } from 'vitest';
import { RedisService } from '@jcool/platform/redis';
import { DRIZZLE, PG_POOL, type DrizzleDB } from '../../src/database';
import { resetDatabase } from './reset-database';
import { createTestApp, type ProviderOverride, type TestAppOptions } from './test-app.factory';

export interface TestAppResources {
  app: INestApplication;
  /** The app's own pool, for resets and raw SQL. */
  pool: Pool;
  db: DrizzleDB;
}

export async function createTestAppWithPool(
  envOverrides: Record<string, string> = {},
  providerOverrides: ProviderOverride[] = [],
  options: TestAppOptions = {},
): Promise<TestAppResources> {
  const app = await createTestApp(envOverrides, providerOverrides, options);
  return { app, pool: app.get<Pool>(PG_POOL), db: app.get<DrizzleDB>(DRIZZLE) };
}

export function redisOf(app: INestApplication): Redis {
  return app.get(RedisService).getClient();
}

// Hooks register when the describe body runs, before the app exists, hence the accessors.

export function closeAppAfterAll(getApp: () => INestApplication | undefined): void {
  afterAll(async () => {
    await getApp()?.close();
  });
}

/** Register before any seeding `beforeEach`: hooks fire in registration order. */
export function resetDatabaseBeforeEach(getPool: () => Pool): void {
  beforeEach(async () => {
    await resetDatabase(getPool());
  });
}
