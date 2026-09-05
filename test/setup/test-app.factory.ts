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

/** Swap one DI token for this app only — e.g. a scriptable gateway at the external-system boundary. */
export interface ProviderOverride {
  provide: unknown;
  useValue: unknown;
}

// Real INestApplication on the container URLs, mirroring main.ts edge config.
// `envOverrides` set config-backing env vars (e.g. INVENTORY_LOCK_STRATEGY) for
// this app only: config reads process.env when the module compiles, so they are
// applied before compile and restored after — one app's strategy never leaks into
// the next (e2e files share this process and run sequentially).
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
  // The four background drivers, forced off so nothing runs behind a test's back: suites call
  // ReconcileStaleOrdersUseCase / OutboxRelay.runOnce / DomainEventProcessor.process /
  // SweepExpiredReservationsUseCase themselves, and a tick firing mid-assertion would settle an
  // order, publish a row, or drain a job the test is still setting up. A suite that wants one of
  // them passes it in `envOverrides`, which is applied below and wins.
  //
  // Assigned unconditionally, NOT with `??=`: the first app's ConfigModule loads the developer's
  // .env into process.env, so from the second app onwards `??=` would silently inherit whatever
  // that file happens to say — making the suite's behaviour depend on an untracked local file.
  // Assigned unconditionally for the same reason, and one more: two apps in a run that bucket under
  // different keys would put a user's id and its token ids in different buckets.
  process.env.IDENTITY_BUCKET_KEY = E2E_IDENTITY_BUCKET_KEY;
  process.env.RECONCILE_ENABLED = 'false';
  process.env.OUTBOX_RELAY_ENABLED = 'false';
  process.env.QUEUE_WORKER_ENABLED = 'false';
  process.env.RESERVATION_SWEEP_ENABLED = 'false';
  // One BullMQ keyspace per spec file. Redis is not truncated between files the way Postgres is, so
  // a file that leaves jobs waiting hands them to the next file that boots a worker — which then
  // applies events its own test never published. Same value for every app in a file, because a
  // suite may drive one app's relay and read the queue through another's.
  process.env.QUEUE_PREFIX = queuePrefixForCurrentSpec();
  // Vitest loads the developer's .env, so a real STRIPE_SECRET_KEY would put createSession on the
  // live path — billable and non-deterministic. Dropped unless a suite asks for it.
  if (!('STRIPE_SECRET_KEY' in envOverrides)) {
    delete process.env.STRIPE_SECRET_KEY;
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
    app.useLogger(app.get(Logger)); // pino logger — mirrors main.ts so e2e logs match prod shape

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
    app.use(cookieParser()); // so auth routes can read the refresh + CSRF cookies
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    try {
      // HttpExceptionFilter is wired via APP_FILTER in AppModule (needs CLS injection).
      await app.init();
      // Bind a real port once, for every suite. supertest ephemeral-listens a non-listening server per
      // request and tears that listener down again when the request ends; firing a herd of concurrent
      // requests at it races those binds and surfaces as `read ECONNRESET`. A listening server is just
      // connected to, so the concurrency under test stays where it belongs — the DB, the cache, the
      // lock — instead of the socket.
      await app.listen(0);
      // The shared client connects lazily and rejects commands until its socket is writable, so an
      // assertion made in the first instants of a suite would measure the Redis-down fall-through.
      await waitForRedisReady(app.get(RedisService).getClient());
      return app;
    } catch (error) {
      // Providers are already constructed by the time init can fail, so the pool and the Redis
      // socket are open and the caller never receives a handle to close them. A suite that asserts a
      // boot guard refuses would leak one set per assertion and hold the run open at the end.
      // Reported, not swallowed: the init failure is the one worth throwing, but a close that also
      // failed means handles are still open and the run may hang long after this line.
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

// Spec filenames are unique, so this is stable within a file and distinct across files — the two
// properties the isolation depends on.
function queuePrefixForCurrentSpec(): string {
  const testPath = expect.getState().testPath;
  return testPath ? `bull:${basename(testPath, '.e2e-spec.ts')}` : 'bull';
}
