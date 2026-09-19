import type { INestApplication, Type } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Logger } from 'nestjs-pino';
import { SCRIPTS_NODE_ID, UuidV8Generator } from '@jcool/id-generator';
import { RedisService } from '@jcool/platform/redis';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { ID_GENERATOR, type IdGeneratorPort } from '../../src/modules/user/application/ports/id-generator.port';
import { E2E_BASE_ENV } from './e2e-env';
import { waitForRedisReady } from './redis-ready';
import { es256KeysEnv } from './signing-keys';
import { workerDatabaseUrl, workerRedisUrl } from './worker-resources';

export type ProviderOverride =
  | { provide: unknown; useValue: unknown }
  | { provide: unknown; useFactory: (...args: never[]) => unknown; inject?: unknown[] };

export interface TestAppOptions {
  /** Test-only routes, mounted under the same global guards as the real ones. */
  controllers?: Type[];
  /** Keep the shipped id-service adapter instead of minting in process. */
  realIdService?: boolean;
}

// Shared by every app in this worker: a second generator on the same node id replays the sequence,
// and some suites hold two apps open against one database.
const generator = UuidV8Generator.create({ nodeId: SCRIPTS_NODE_ID });

export const inProcessIdGenerator: IdGeneratorPort = {
  mint: (bucket, count = 1) => Promise.resolve(Array.from({ length: count }, () => generator.generate(bucket))),
};

// Config is read when the module compiles, so overrides are applied before compile and restored
// after: one app's env never reaches the next.
export async function createTestApp(
  envOverrides: Record<string, string> = {},
  providerOverrides: ProviderOverride[] = [],
  options: TestAppOptions = {},
): Promise<INestApplication> {
  Object.assign(process.env, E2E_BASE_ENV, {
    NODE_ENV: 'test',
    DATABASE_URL: workerDatabaseUrl(),
    REDIS_URL: workerRedisUrl(),
    JWT_ES256_PRIVATE_KEYS: es256KeysEnv(),
  });
  // Read per request, so a throttle suite flips it around its own app.
  process.env.THROTTLE_ENABLED ??= 'false';
  if (!('SMTP_URL' in envOverrides)) {
    delete process.env.SMTP_URL;
    delete process.env.MAIL_FROM;
  }

  const savedEnv: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(envOverrides)) {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  }

  const overrides =
    options.realIdService || providerOverrides.some((override) => override.provide === ID_GENERATOR)
      ? providerOverrides
      : [{ provide: ID_GENERATOR, useValue: inProcessIdGenerator }, ...providerOverrides];

  try {
    let builder = Test.createTestingModule({ imports: [AppModule], controllers: options.controllers ?? [] });
    for (const override of overrides) {
      const by = builder.overrideProvider(override.provide);
      builder =
        'useValue' in override
          ? by.useValue(override.useValue)
          : by.useFactory({ factory: override.useFactory, inject: override.inject });
    }
    const moduleRef = await builder.compile();
    const app = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true });
    try {
      app.useLogger(app.get(Logger));
      configureApp(app);
      await app.init();
      // A real port: supertest's per-request ephemeral listeners race under concurrent requests.
      await app.listen(0);
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
