import { Logger as NestLogger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { CSRF_HEADER } from '@modules/user/interface/security';

async function bootstrap(): Promise<void> {
  // Buffer bootstrap logs until the pino logger is installed, then replay them through it
  // (so early logs are JSON too, not NestJS's default console format).
  // `rawBody: true` captures the exact request bytes on `req.rawBody` (alongside the parsed body)
  // so the payment webhook can verify its HMAC signature over what the gateway actually signed —
  // the global JSON parser would re-serialize and break it.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true, rawBody: true });
  const logger = app.get(Logger);
  app.useLogger(logger);
  const configService = app.get(ConfigService);

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
  app.enableShutdownHooks();

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
  NestLogger.error(error instanceof Error ? (error.stack ?? error.message) : String(error), undefined, 'Bootstrap');
  NestLogger.flush();
  process.exit(1);
});
