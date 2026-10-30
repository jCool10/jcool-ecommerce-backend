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
  Object.assign(process.env, E2E_BASE_ENV, {
    NODE_ENV: 'test',
    DATABASE_URL: workerDatabaseUrl(),
    REDIS_URL: workerRedisUrl(),
    ID_SERVICE_URL: (await idServiceStub()).url,
  });
  // A real key would put session creation on Stripe's live path.
  delete process.env.STRIPE_SECRET_KEY;

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
    // rawBody as in main.ts: the webhook signature is checked over the bytes received.
    const app = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true, rawBody: true });
    try {
      app.useLogger(app.get(Logger));
      configureApp(app);
      await app.init();
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
