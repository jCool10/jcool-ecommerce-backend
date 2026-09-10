import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger as NestLogger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { CSRF_HEADER } from '@shared/auth';
import { UserAppModule } from './app.module';

/**
 * Read off disk, not `import pkg from '../package.json'`: the SWC builder has `sourceRoot: "src"`,
 * so importing a file above it pulls package.json into the compilation and shifts the output path.
 */
function readApiVersion(): string {
  try {
    const pkg: unknown = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
    const version = (pkg as { version?: unknown }).version;
    return typeof version === 'string' ? version : '0.0.0';
  } catch {
    return process.env.npm_package_version ?? '0.0.0';
  }
}

async function bootstrap(): Promise<void> {
  // No `rawBody`: that exists for the payment webhook's HMAC, and this app has no webhook sink.
  const app = await NestFactory.create<NestExpressApplication>(UserAppModule, { bufferLogs: true });
  const logger = app.get(Logger);
  app.useLogger(logger);
  const configService = app.get(ConfigService);

  // Off by default: on a direct deploy, trusting the proxy would let any client spoof its own
  // rate-limit and audit identity through X-Forwarded-For — and this app is the login endpoint.
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
  app.enableShutdownHooks();

  const port = configService.get<number>('app.port') ?? 3001;

  if (swaggerEnabled) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('JCool User API')
      .setDescription(
        [
          'Identity and sessions for the JCool storefront — the only issuer of access tokens.',
          '',
          '- Register, login, email verification, password reset, password change.',
          '- Refresh-token rotation with reuse detection, session listing and revocation.',
          '- Sharding-ready UUIDv8 user ids with an HMAC routing bucket.',
          '',
          'Commerce routes live on a separate service; it verifies these tokens with the public key.',
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
  logger.log(`User service running on http://localhost:${port}`, 'Bootstrap');
}

void bootstrap().catch((error: unknown) => {
  NestLogger.error(error instanceof Error ? (error.stack ?? error.message) : String(error), undefined, 'Bootstrap');
  NestLogger.flush();
  process.exit(1);
});
