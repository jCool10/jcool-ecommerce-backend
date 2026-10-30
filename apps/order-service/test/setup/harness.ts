import type { INestApplication } from '@nestjs/common';
import type { Queue } from 'bullmq';
import type { Pool } from 'pg';
import { afterAll, beforeEach } from 'vitest';
import { DRIZZLE, PG_POOL, type DrizzleDB } from '../../src/database';
import { resetCheckoutSagas } from './fixtures/checkout-saga.fixture';
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

/** Saga runs outlive a TRUNCATE, so they are terminated first, while their order ids can still be read. */
export function resetSagasAndDatabaseBeforeEach(getApps: () => INestApplication[], getPool: () => Pool): void {
  beforeEach(async () => {
    await resetCheckoutSagas(getApps());
    await resetDatabase(getPool());
  });
}

/** Redis is not truncated between files the way Postgres is, so a relayed job outlives its test. */
export function obliterateQueueBeforeEach(getQueues: () => Queue[]): void {
  beforeEach(async () => {
    for (const queue of getQueues()) {
      await queue.obliterate({ force: true });
    }
  });
}
