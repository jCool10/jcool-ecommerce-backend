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

// Real INestApplication on the container URLs, mirroring main.ts edge config.
export async function createTestApp(): Promise<INestApplication> {
  // Set before AppModule loads: @nestjs/config's dotenv won't override these, so
  // the container URLs win over any local .env.
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = inject('DATABASE_URL');
  process.env.REDIS_URL = inject('REDIS_URL');
  process.env.JWT_ACCESS_SECRET ??= 'test-jwt-access-secret-not-a-real-secret-000'; // schema needs ≥32 chars
  // Rate limiting off by default so the shared loopback IP doesn't make suites
  // flaky. A suite that tests throttling sets THROTTLE_ENABLED='true' first.
  process.env.THROTTLE_ENABLED ??= 'false';

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true });
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
}
