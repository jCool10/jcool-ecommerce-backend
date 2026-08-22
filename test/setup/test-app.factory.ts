import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { inject } from 'vitest';
import { AppModule } from '../../src/app.module';
import { CSRF_HEADER } from '../../src/modules/user/interface/security/auth-cookie.constants';

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
  // Suites drive ReconcileStaleOrdersUseCase directly, so a tick can never fire mid-assertion and
  // settle an order the test is still setting up.
  process.env.RECONCILE_ENABLED ??= 'false';
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
    // HttpExceptionFilter is wired via APP_FILTER in AppModule (needs CLS injection).
    await app.init();
    return app;
  } finally {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
