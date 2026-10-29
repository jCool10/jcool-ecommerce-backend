import type { INestApplication } from '@nestjs/common';
import type { Queue } from 'bullmq';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeEach } from 'vitest';
import { DRIZZLE, PG_POOL, type DrizzleDB } from '../../src/database';
import { PAYMENT_GATEWAY } from '../../src/modules/payment/application/ports/payment-gateway.port';
import { FakeSignerGatewayAdapter } from '../../src/modules/payment/infrastructure/gateway/fake-signer-gateway.adapter';
import { E2E_API_CALLER_TOKEN } from './e2e-env';
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

export interface TestAppWithGateway extends TestAppResources {
  /** Stripe, the one boundary outside the service: it signs like Stripe and settles on demand. */
  gateway: FakeSignerGatewayAdapter;
}

// The secret goes after the spread: an override would leave the app verifying with one value and the
// gateway signing with another.
export async function createTestAppWithFakeGateway(
  webhookSecret: string,
  envOverrides: EnvOverrides = {},
  providerOverrides: ProviderOverride[] = [],
): Promise<TestAppWithGateway> {
  const gateway = new FakeSignerGatewayAdapter(webhookSecret);
  const resources = await createTestAppWithPool({ ...envOverrides, PAYMENT_WEBHOOK_SECRET: webhookSecret }, [
    { provide: PAYMENT_GATEWAY, useValue: gateway },
    ...providerOverrides,
  ]);
  return { ...resources, gateway };
}

/** A POST to the internal API as the api would send it. */
export function internalPost(app: INestApplication, path: string, token: string | null = E2E_API_CALLER_TOKEN) {
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

/** Redis is not truncated between files the way Postgres is, so a relayed job outlives its test. */
export function obliterateQueueBeforeEach(getQueues: () => Queue[]): void {
  beforeEach(async () => {
    for (const queue of getQueues()) {
      await queue.obliterate({ force: true });
    }
  });
}
