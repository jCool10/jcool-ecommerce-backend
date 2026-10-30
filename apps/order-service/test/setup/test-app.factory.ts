import { basename } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Logger } from 'nestjs-pino';
import { expect, inject } from 'vitest';
import { RedisService } from '@jcool/platform/redis';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { apiInternalStub } from './api-internal-stub';
import { E2E_BASE_ENV } from './e2e-env';
import { idServiceStub } from './id-service-stub';
import { inventoryServiceStub } from './inventory-service-stub';
import { paymentServiceStub } from './payment-service-stub';
import { waitForRedisReady } from './redis-ready';
import { TEMPORAL_TEST_NAMESPACE } from './temporal-server';
import { temporalTaskQueueForCurrentSpec } from './temporal-task-queue';
import { userServiceStub } from './user-service-stub';
import { workerDatabaseUrl, workerRedisUrl } from './worker-resources';

export type EnvOverrides = Record<string, string | undefined>;

export interface ProviderOverride {
  provide: unknown;
  useValue: unknown;
}

// Config is read when the module compiles, so overrides are applied before compile and restored
// after: one app's env never reaches the next. `undefined` unsets a variable.
export async function createTestApp(
  envOverrides: EnvOverrides = {},
  providerOverrides: ProviderOverride[] = [],
): Promise<INestApplication> {
  const userService = await userServiceStub();
  Object.assign(process.env, E2E_BASE_ENV, {
    NODE_ENV: 'test',
    DATABASE_URL: workerDatabaseUrl(),
    REDIS_URL: workerRedisUrl(),
    AUTH_JWKS_URL: userService.jwksUrl,
    USER_SERVICE_URL: userService.url,
    ID_SERVICE_URL: (await idServiceStub()).url,
    API_SERVICE_URL: (await apiInternalStub()).url,
    INVENTORY_SERVICE_URL: (await inventoryServiceStub()).url,
    PAYMENT_SERVICE_URL: (await paymentServiceStub()).url,
    // Redis is not truncated between files, so leftover jobs would reach the next file's worker.
    QUEUE_PREFIX: queuePrefixForCurrentSpec(),
    // Every checkout runs the saga: an app without a worker answers 503 to POST /orders.
    TEMPORAL_WORKER_ENABLED: 'true',
    TEMPORAL_ADDRESS: inject('TEMPORAL_ADDRESS'),
    TEMPORAL_NAMESPACE: TEMPORAL_TEST_NAMESPACE,
    TEMPORAL_TASK_QUEUE: temporalTaskQueueForCurrentSpec(),
    TEMPORAL_WORKFLOW_BUNDLE_PATH: inject('TEMPORAL_WORKFLOW_BUNDLE_PATH'),
  });
  // A copied .env would mail the developer's local Mailpit from every suite.
  if (!('SMTP_URL' in envOverrides)) {
    delete process.env.SMTP_URL;
    delete process.env.MAIL_FROM;
  }

  const savedEnv: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(envOverrides)) {
    savedEnv[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  try {
    let builder = Test.createTestingModule({ imports: [AppModule] });
    for (const override of providerOverrides) {
      builder = builder.overrideProvider(override.provide).useValue(override.useValue);
    }
    const moduleRef = await builder.compile();
    const app = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true });
    try {
      app.useLogger(app.get(Logger));
      configureApp(app);
      await app.init();
      // A real port: supertest's per-request ephemeral listeners race under concurrent herds.
      // Loopback, not `::`: on macOS a wildcard can share its port with another worker's listener.
      await app.listen(0, '127.0.0.1');
      await waitForRedisReady(app.get(RedisService).getClient());
      return app;
    } catch (error) {
      await app.close().catch((closeError: unknown) => {
        console.error('createTestApp: closing a partially initialised app failed', closeError);
      });
      throw error;
    }
  } finally {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// Spec filenames are unique, so the prefix is stable within a file and distinct across files.
function queuePrefixForCurrentSpec(): string {
  const testPath = expect.getState().testPath;
  return testPath ? `bull:${basename(testPath, '.e2e-spec.ts')}` : 'bull';
}
