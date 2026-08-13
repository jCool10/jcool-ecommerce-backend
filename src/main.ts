import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { CSRF_HEADER } from './modules/user/interface/security/auth-cookie.constants';
import { HttpExceptionFilter } from './shared/interface/filters/http-exception.filter';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
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
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new HttpExceptionFilter());

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
    Logger.log('Swagger UI available at /docs', 'Bootstrap');
  }

  await app.listen(port);
  Logger.log(`Application running on http://localhost:${port}`, 'Bootstrap');
}

// Fail-fast: any bootstrap failure (e.g. env validation) exits non-zero.
void bootstrap().catch((error: unknown) => {
  Logger.error(error instanceof Error ? error.message : String(error), undefined, 'Bootstrap');
  process.exit(1);
});
