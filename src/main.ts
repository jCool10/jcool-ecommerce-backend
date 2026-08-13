import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './shared/interface/filters/http-exception.filter';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  // Parse cookies so the auth routes can read the refresh + CSRF cookies.
  app.use(cookieParser());

  // Validate DTOs at the edge: strip unknown props and reject any that are sent
  // so a malformed request fails loudly instead of being silently trimmed.
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new HttpExceptionFilter());

  // Let SIGTERM/SIGINT run lifecycle hooks (DrizzleModule drains the pg pool).
  app.enableShutdownHooks();

  const configService = app.get(ConfigService);
  const port = configService.get<number>('app.port') ?? 3000;

  // OpenAPI docs at /docs, gated by config (off in production unless enabled).
  if (configService.get<boolean>('app.swaggerEnabled')) {
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
