import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger as NestLogger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { Logger, PinoLogger } from 'nestjs-pino';
import { swaggerContentSecurityPolicy } from '@jcool/platform/interface';
import { logProcessCrashes } from '@jcool/platform/observability';
import { AppModule } from './app.module';

/**
 * Read off disk, not `import pkg from '../package.json'`: the SWC builder has `sourceRoot: "src"`,
 * so importing a file above it pulls package.json into the compilation and shifts the output to
 * `dist/src/main.js`, breaking `start:prod`. Typecheck stays green, so it only surfaces at deploy.
 */
function readApiVersion(): string {
  try {
    const pkg: unknown = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
    const version = (pkg as { version?: unknown }).version;
    return typeof version === 'string' ? version : '0.0.0';
  } catch {
    // Docs are not worth refusing to boot over; npm exports the same value when it started us.
    return process.env.npm_package_version ?? '0.0.0';
  }
}

async function bootstrap(): Promise<void> {
  // `rawBody: true` captures the exact request bytes on `req.rawBody` so the payment webhook can
  // verify its HMAC signature over what the gateway actually signed — the global JSON parser would
  // re-serialize and break it.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true, rawBody: true });
  const logger = app.get(Logger);
  app.useLogger(logger);
  logProcessCrashes(await app.resolve(PinoLogger));
  const configService = app.get(ConfigService);

  // Trusting the proxy makes `req.ip` the rate-limit and audit key, so it stays off by default:
  // on a direct deploy it would let any client spoof itself via X-Forwarded-For.
  const trustProxy = configService.get<boolean | number | string>('app.trustProxy');
  if (trustProxy !== false) {
    app.set('trust proxy', trustProxy);
  }

  // The default CSP blocks Swagger UI's inline bootstrap, so `script-src` is relaxed — and only that
  // directive, and only when the docs are served.
  const swaggerEnabled = configService.get<boolean>('app.swaggerEnabled');
  app.use(helmet({ contentSecurityPolicy: swaggerEnabled ? swaggerContentSecurityPolicy : undefined }));

  // Every route here is Bearer-authenticated; cookies belong to the user-service's own origin rules.
  const corsOrigins = configService.get<string[]>('app.corsOrigins') ?? [];
  app.enableCors({
    origin: corsOrigins.length > 0 ? corsOrigins : false,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  // The global exception filter is wired via APP_FILTER (app.module) so it can inject CLS.
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));

  app.enableShutdownHooks();

  const port = configService.get<number>('app.port') ?? 3000;

  if (swaggerEnabled) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('JCool E-commerce API')
      .setDescription(
        [
          'Single-store e-commerce backend — five bounded contexts in one deployable process.',
          '',
          '- **Catalog** — public product/SKU reads and search; admin CRUD behind `ADMIN`.',
          '- **Cart** — per-user cart lines, priced from the catalog at read time.',
          '- **Order** — checkout: the order, not the cart, is the source of truth for a transaction.',
          '- **Payment** — gateway sessions and the webhook sink; one purchase intent, one charge.',
          '- **Inventory** — stock reservations that hold the "never oversell" invariant under contention.',
        ].join('\n'),
      )
      .setVersion(readApiVersion())
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('docs', app, document);
    logger.log('Swagger UI available at /docs', 'Bootstrap');
  }

  await app.listen(port);
  logger.log(
    {
      port,
      env: configService.get<string>('app.env'),
      logLevel: configService.get<string>('log.level'),
      swaggerEnabled,
      trustProxy,
      corsOrigins: corsOrigins.length,
      searchEnabled: configService.get<boolean>('search.enabled'),
      inventoryLockStrategy: configService.get<string>('inventory.lockStrategy'),
      queueWorkerEnabled: configService.get<boolean>('queue.workerEnabled'),
      queueWorkerConcurrency: configService.get<number>('queue.workerConcurrency'),
      tracingEnabled: configService.get<boolean>('tracing.enabled'),
      sentryEnabled: configService.get<boolean>('sentry.enabled'),
      lokiEnabled: Boolean(configService.get<string>('loki.url')),
      storageBucket: configService.get<string>('storage.bucket'),
      storageEndpointHost: hostOnly(configService.get<string>('storage.endpoint')),
    },
    'application started',
    'Bootstrap',
  );
}

/** Host only, so credentials embedded in the URL never reach the log. */
function hostOnly(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

void bootstrap().catch((error: unknown) => {
  NestLogger.error(error instanceof Error ? (error.stack ?? error.message) : String(error), undefined, 'Bootstrap');
  NestLogger.flush();
  process.exit(1);
});
