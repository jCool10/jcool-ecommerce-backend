import type { INestApplication } from '@nestjs/common';
import type { Queue } from 'bullmq';
import type { Pool } from 'pg';
import { afterAll, beforeEach } from 'vitest';
import { DRIZZLE, PG_POOL, type DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import { resetCheckoutSagas } from './fixtures/checkout-saga.fixture';
import type { StartedObjectStorage } from './object-storage';
import { resetDatabase } from './reset-database';
import { createTestApp, type EnvOverrides, type ProviderOverride } from './test-app.factory';

/**
 * Thin wrappers over `createTestApp`, which stays the single owner of the env hygiene every e2e app
 * depends on (`test-app.factory.ts`). Nothing here changes how an app is built; these only save spec
 * files from repeating the same container lookups and teardown hooks.
 */

export interface TestAppResources {
  app: INestApplication;
  /** For `resetDatabase` and raw SQL; the same pool the app's repositories use. */
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

/**
 * Points the app at an already-started MinIO. The container is the caller's, because it is also the
 * caller's assertion surface (`listKeys`, `exists`) and its lifetime spans the whole file.
 */
export async function createTestAppWithObjectStorage(
  storage: StartedObjectStorage,
  envOverrides: EnvOverrides = {},
  providerOverrides: ProviderOverride[] = [],
): Promise<TestAppResources> {
  return createTestAppWithPool(
    {
      ...envOverrides,
      // After the spread, not before: these four ARE the wiring this wrapper exists to guarantee, so
      // a caller that passes one in `envOverrides` would otherwise silently point the app at a
      // different bucket than the one it then asserts against.
      STORAGE_ENDPOINT: storage.endpoint,
      STORAGE_BUCKET: storage.bucket,
      STORAGE_ACCESS_KEY_ID: storage.accessKeyId,
      STORAGE_SECRET_ACCESS_KEY: storage.secretAccessKey,
    },
    providerOverrides,
  );
}

/**
 * Hooks are collected when the describe body runs, never later: registering one from inside
 * `beforeAll` is silently dropped by Vitest. So these take an accessor: the app does not exist yet
 * at registration time, only by the time the hook fires.
 */

/** Leaving an app open holds its Postgres pool and Redis sockets for the rest of the worker's run. */
export function closeAppAfterAll(getApp: () => INestApplication | undefined): void {
  afterAll(async () => {
    await getApp()?.close();
  });
}

/**
 * Truncates this worker's database before every test. Call it before any other `beforeEach` that
 * seeds: hooks fire in registration order, and seeded rows must survive the truncate.
 *
 * A file whose reset is sequenced against a cache bump or a queue obliterate keeps its own explicit
 * `beforeEach` instead: the order there is the point, and burying it in an option hides it.
 */
export function resetDatabaseBeforeEach(getPool: () => Pool): void {
  beforeEach(async () => {
    await resetDatabase(getPool());
  });
}

/**
 * For suites with a Temporal worker. Saga runs outlive a TRUNCATE, so they are terminated first,
 * while their order ids can still be read.
 */
export function resetSagasAndDatabaseBeforeEach(getApps: () => INestApplication[], getPool: () => Pool): void {
  beforeEach(async () => {
    await resetCheckoutSagas(getApps());
    await resetDatabase(getPool());
  });
}

/**
 * Redis is not truncated between files the way Postgres is, so jobs a test leaves waiting are
 * applied by the next test that starts a worker.
 */
export function obliterateQueueBeforeEach(getQueues: () => Queue[]): void {
  beforeEach(async () => {
    for (const queue of getQueues()) {
      await queue.obliterate({ force: true });
    }
  });
}
