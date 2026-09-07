import { Logger as NestLogger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import * as Sentry from '@sentry/nestjs';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { Logger, PinoLogger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { CSRF_HEADER } from '@modules/user/interface/security';
import configuration from '@shared/config/configuration';
import { buildBootSummary, flushLogsSync, logBootstrapFailure, registerFatalHandlers } from '@shared/observability';

// How long a dying process waits for Sentry to ship the crash before it exits anyway. Short: the
// process is already gone, and a hung reporter must not turn a crash into a hang.
const SENTRY_DRAIN_MS = 2000;

async function bootstrap(): Promise<void> {
  // Buffer bootstrap logs until the pino logger is installed, then replay them through it
  // (so early logs are JSON too, not NestJS's default console format).
  // `rawBody: true` captures the exact request bytes on `req.rawBody` (alongside the parsed body)
  // so the payment webhook can verify its HMAC signature over what the gateway actually signed —
  // the global JSON parser would re-serialize and break it.
  // `abortOnError: false` makes a failed boot reject instead of Nest killing the process from
  // inside create(), which is the only way the catch below gets to write the failure as JSON.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    rawBody: true,
    abortOnError: false,
  });
  const logger = app.get(Logger);
  app.useLogger(logger);
  const configService = app.get(ConfigService);

  // The two deaths that happen outside every try/catch. Registered as early as the logger allows,
  // because a crash during the rest of bootstrap is exactly as worth reading as one under load.
  // `resolve`, not `get`: nestjs-pino registers PinoLogger as transient-scoped, so `get` throws.
  // The drain gives Sentry's async transport a bounded window to ship the crash: registering these
  // handlers makes its own integration stop owning the exit, so without it the crash event dies
  // with the process. Resolves immediately when no DSN is configured.
  registerFatalHandlers(await app.resolve(PinoLogger), { drain: () => Sentry.close(SENTRY_DRAIN_MS) });
  // Node's last quiet exit path: nothing threw, the loop just emptied. Flush before it does.
  process.on('beforeExit', flushLogsSync);

  // One line naming every feature gate this build booted with, so "why is prod behaving
  // differently" is answerable from the log platform instead of a shell on the box.
  logger.log(buildBootSummary(configService), 'boot configuration', 'Bootstrap');

  // Behind a reverse proxy, trust it so `req.ip` is the real client IP (rate-limit + audit key);
  // env-gated, off by default so a direct deploy can't be spoofed via X-Forwarded-For.
  const trustProxy = configService.get<boolean | number | string>('app.trustProxy');
  if (trustProxy !== false) {
    app.set('trust proxy', trustProxy);
  }

  // Security headers (HSTS, X-Content-Type-Options, frameguard…). The default CSP blocks
  // Swagger UI's inline assets, so it's disabled only when the docs are served.
  const swaggerEnabled = configService.get<boolean>('app.swaggerEnabled');
  app.use(helmet({ contentSecurityPolicy: swaggerEnabled ? false : undefined }));

  // CORS off unless an explicit allow-list is configured; credentials on so auth cookies
  // can ride cross-origin XHR from a whitelisted origin.
  const corsOrigins = configService.get<string[]>('app.corsOrigins') ?? [];
  app.enableCors({
    origin: corsOrigins.length > 0 ? corsOrigins : false,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', CSRF_HEADER],
  });

  // Parse cookies so the auth routes can read the refresh + CSRF cookies.
  app.use(cookieParser());

  // Validate DTOs at the edge: strip unknown props and reject any sent (fail loud, not silent).
  // The global exception filter is wired via APP_FILTER (app.module) so it can inject CLS.
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));

  // Let SIGTERM/SIGINT run lifecycle hooks (DrizzleModule drains the pg pool).
  // `useProcessExit` makes Nest leave via process.exit() instead of re-raising the signal at
  // itself. Re-raising skips the 'exit' event, and the batched log destination flushes on 'exit' —
  // so anything logged by a shutdown hook after the last explicit flush would die in the buffer,
  // which is precisely the rolling-deploy window worth reading.
  app.enableShutdownHooks([], { useProcessExit: true });

  const port = configService.get<number>('app.port') ?? 3000;

  // OpenAPI docs at /docs, gated by config (off in production unless enabled).
  if (swaggerEnabled) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('JCool E-commerce API')
      .setDescription(
        'Catalog read paths + admin CRUD write paths (RBAC) + Auth (register/login, JWT-protected routes, refresh rotation + logout)',
      )
      .setVersion('0.4.0')
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('docs', app, document);
    logger.log('Swagger UI available at /docs', 'Bootstrap');
  }

  await app.listen(port);
  logger.log(`Application running on http://localhost:${port}`, 'Bootstrap');
}

void bootstrap().catch((error: unknown) => {
  // Boot can fail before app.useLogger(pino) runs, so nothing has replayed the buffered logs yet.
  // Outside dev, emit the failure in the same JSON shape as the rest of production — NestJS's
  // console format is the one output a log platform cannot parse, on the one event always worth
  // reading. Dev keeps the readable console stack.
  if (process.env.NODE_ENV === 'development') {
    NestLogger.error(error instanceof Error ? (error.stack ?? error.message) : String(error), undefined, 'Bootstrap');
    NestLogger.flush();
  } else {
    // configuration() is a pure read of process.env, so it works with no container to ask.
    const { log } = configuration();
    logBootstrapFailure(error, { service: log.service, env: process.env.NODE_ENV, version: log.version });
    flushLogsSync();
  }
  process.exit(1);
});
