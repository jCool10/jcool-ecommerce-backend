import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Logger } from 'nestjs-pino';
import { RedisService } from '@jcool/platform/redis';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { E2E_BASE_ENV } from './e2e-env';
import { idServiceStub } from './id-service-stub';
import { waitForRedisReady } from './redis-ready';
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
  });
  // Read per request, so a throttle suite flips it around its own app.
  process.env.THROTTLE_ENABLED ??= 'false';

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
      // A real port, on loopback: supertest's per-request ephemeral listeners race under concurrent
      // requests, and on macOS a `::` wildcard can share its port with another worker's listener.
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
