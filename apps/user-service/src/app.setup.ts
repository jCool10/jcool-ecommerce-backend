import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { CSRF_HEADER } from './modules/user/interface/security';

/** Served under `/auth` so the gateway's one auth route covers it. */
export const SWAGGER_PATH = 'auth/docs';

/** What main.ts adds on top of the module graph, shared so the e2e app is the one that ships. */
export function configureApp(app: NestExpressApplication): void {
  const config = app.get(ConfigService);

  // Makes `req.ip` the rate-limit and audit key; off unless the proxy chain is declared.
  const trustProxy = config.get<boolean | number | string>('app.trustProxy');
  if (trustProxy !== false) {
    app.set('trust proxy', trustProxy);
  }

  // The default CSP blocks Swagger UI's inline assets.
  const swaggerEnabled = config.get<boolean>('app.swaggerEnabled') === true;
  app.use(helmet({ contentSecurityPolicy: swaggerEnabled ? false : undefined }));

  const corsOrigins = config.get<string[]>('app.corsOrigins') ?? [];
  app.enableCors({
    origin: corsOrigins.length > 0 ? corsOrigins : false,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', CSRF_HEADER],
  });

  app.use(cookieParser());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));

  if (swaggerEnabled) {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('JCool User Service')
        .setDescription('Registration, login, sessions and the rest of `/auth`.')
        .addBearerAuth()
        .build(),
    );
    SwaggerModule.setup(SWAGGER_PATH, app, document);
  }
}
