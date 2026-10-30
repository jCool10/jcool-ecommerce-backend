import type { INestApplication } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeEach } from 'vitest';
import { RedisService } from '@jcool/platform/redis';
import { DRIZZLE, PG_POOL, type DrizzleDB } from '../../src/database';
import { E2E_CALLER_TOKEN } from './e2e-env';
import { resetDatabase } from './reset-database';
import { createTestApp, type EnvOverrides, type ProviderOverride } from './test-app.factory';

export interface TestAppResources {
  app: INestApplication;
  /** The app's own pool, for resets and raw SQL. */
  pool: Pool;
  db: DrizzleDB;
}

export async function createTestAppWithPool(
  envOverrides: EnvOverrides = {},
  providerOverrides: ProviderOverride[] = [],
): Promise<TestAppResources> {
  const app = await createTestApp(envOverrides, providerOverrides);
  return { app, pool: app.get<Pool>(PG_POOL), db: app.get<DrizzleDB>(DRIZZLE) };
}

export function redisOf(app: INestApplication): Redis {
  return app.get(RedisService).getClient();
}

/** A POST to the internal API as the order-service would send it. */
export function internalPost(app: INestApplication, path: string, token: string | null = E2E_CALLER_TOKEN) {
  const req = request(app.getHttpServer()).post(path);
  return token === null ? req : req.set('Authorization', `Bearer ${token}`);
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
