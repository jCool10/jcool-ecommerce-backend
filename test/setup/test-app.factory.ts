import { basename } from 'node:path';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { expect, inject } from 'vitest';
import { AppModule } from '../../src/app.module';
import { CSRF_HEADER } from '../../src/modules/user/interface/security/auth-cookie.constants';
import { RedisService } from '../../src/shared/infrastructure/redis';
import { E2E_IDENTITY_BUCKET_KEY } from './identity.helper';
import { waitForRedisReady } from './redis-ready';

export interface ProviderOverride {
  provide: unknown;
  useValue: unknown;
}

// `envOverrides` set config-backing env vars for this app only: config reads process.env when the
// module compiles, so they are applied before compile and restored after — one app's config never
// leaks into the next (e2e files share this process and run sequentially).
export async function createTestApp(
  envOverrides: Record<string, string> = {},
  providerOverrides: ProviderOverride[] = [],
): Promise<INestApplication> {
  // Set before AppModule loads: @nestjs/config's dotenv won't override these, so
  // the container URLs win over any local .env.
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = inject('DATABASE_URL');
  process.env.REDIS_URL = inject('REDIS_URL');
  process.env.JWT_ACCESS_SECRET ??= 'test-jwt-access-secret-not-a-real-secret-000'; // schema needs ≥32 chars
  // Payment defaults to the Stripe adapter, which refuses to construct without a webhook secret;
  // provide a dummy so AppModule boots. Signed-webhook e2e can override with its own known secret.
  process.env.PAYMENT_WEBHOOK_SECRET ??= 'whsec_test_not_a_real_secret_0000'; // schema needs ≥16 chars
  // Rate limiting off by default so the shared loopback IP doesn't make suites
  // flaky. A suite that tests throttling sets THROTTLE_ENABLED='true' first.
  process.env.THROTTLE_ENABLED ??= 'false';
  // Background drivers forced off so nothing runs behind a test's back — a tick firing mid-assertion
  // would settle an order, publish a row, drain a job, or DELETE the row under assertion. Assigned
  // unconditionally, NOT with `??=`: the first app's ConfigModule loads the developer's .env into
  // process.env, so from the second app onwards `??=` would inherit an untracked local file. The
  // bucket key must also be identical across apps, or a user's id and its token ids split buckets.
  process.env.IDENTITY_BUCKET_KEY = E2E_IDENTITY_BUCKET_KEY;
  process.env.RECONCILE_ENABLED = 'false';
  process.env.OUTBOX_RELAY_ENABLED = 'false';
  process.env.QUEUE_WORKER_ENABLED = 'false';
  process.env.RESERVATION_SWEEP_ENABLED = 'false';
  process.env.RETENTION_ENABLED = 'false';
  // One BullMQ keyspace per spec file. Redis is not truncated between files the way Postgres is, so
  // a file that leaves jobs waiting hands them to the next file that boots a worker — which then
  // applies events its own test never published. Same value for every app in a file, because a
  // suite may drive one app's relay and read the queue through another's.
  process.env.QUEUE_PREFIX = queuePrefixForCurrentSpec();
  // Vitest loads the developer's .env, so a real STRIPE_SECRET_KEY would put createSession on the
  // live path — billable and non-deterministic.
  if (!('STRIPE_SECRET_KEY' in envOverrides)) {
    delete process.env.STRIPE_SECRET_KEY;
  }
  // Same reason: `.env.example` ships an SMTP_URL, so a copied .env would put every suite in this
  // file on the real transport, mailing a developer's local Mailpit from unrelated tests.
  if (!('SMTP_URL' in envOverrides)) {
    delete process.env.SMTP_URL;
    delete process.env.MAIL_FROM;
  }
  // Same again for object storage: `.env.example` ships the local MinIO credentials, so a copied
  // .env would point every suite's uploads at the developer's own bucket — and leave objects there.
  if (!('STORAGE_ENDPOINT' in envOverrides)) {
    delete process.env.STORAGE_ENDPOINT;
    delete process.env.STORAGE_BUCKET;
    delete process.env.STORAGE_ACCESS_KEY_ID;
    delete process.env.STORAGE_SECRET_ACCESS_KEY;
    delete process.env.STORAGE_PUBLIC_BASE_URL;
  }

  const savedEnv: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(envOverrides)) {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  }

  try {
    let builder = Test.createTestingModule({ imports: [AppModule] });
    for (const override of providerOverrides) {
      builder = builder.overrideProvider(override.provide).useValue(override.useValue);
    }
    const moduleRef = await builder.compile();
    // `rawBody: true` mirrors main.ts so the payment webhook's raw-body signature check works in e2e.
    const app = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true, rawBody: true });
    app.useLogger(app.get(Logger));

    // Mirror main.ts edge config so the e2e app exercises the same middleware.
    const configService = app.get(ConfigService);
    const trustProxy = configService.get<boolean | number | string>('app.trustProxy');
    if (trustProxy !== false) {
      app.set('trust proxy', trustProxy);
    }
    const swaggerEnabled = configService.get<boolean>('app.swaggerEnabled');
    app.use(helmet({ contentSecurityPolicy: swaggerEnabled ? false : undefined }));
    const corsOrigins = configService.get<string[]>('app.corsOrigins') ?? [];
    app.enableCors({
      origin: corsOrigins.length > 0 ? corsOrigins : false,
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', CSRF_HEADER],
    });
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    try {
      // HttpExceptionFilter is wired via APP_FILTER in AppModule (needs CLS injection).
      await app.init();
      // Bind a real port. supertest ephemeral-listens a non-listening server per request and tears
      // that listener down again; firing a herd of concurrent requests races those binds and
      // surfaces as `read ECONNRESET`, moving the race off the DB/cache/lock under test.
      await app.listen(0);
      await waitForRedisReady(app.get(RedisService).getClient());
      return app;
    } catch (error) {
      // Providers are constructed by the time init can fail, so the pool and Redis socket are open
      // and the caller never gets a handle to close them. The close error is logged, not thrown: the
      // init failure is the useful one, but a failed close means the run may hang later.
      await app.close().catch((closeError) => {
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

// Spec filenames are unique: stable within a file, distinct across files — what the isolation needs.
function queuePrefixForCurrentSpec(): string {
  const testPath = expect.getState().testPath;
  return testPath ? `bull:${basename(testPath, '.e2e-spec.ts')}` : 'bull';
}
