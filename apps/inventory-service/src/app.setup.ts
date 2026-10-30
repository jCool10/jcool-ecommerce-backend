import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';

/** What main.ts adds on top of the module graph, shared so the e2e app is the one that ships. */
export function configureApp(app: NestExpressApplication): void {
  const config = app.get(ConfigService);

  // Makes `req.ip` the rate-limit key on the admin routes; off unless the proxy chain is declared.
  const trustProxy = config.get<boolean | number | string>('app.trustProxy');
  if (trustProxy !== false) {
    app.set('trust proxy', trustProxy);
  }

  // No browser calls this service directly: the admin UI goes through the gateway's origin.
  app.use(helmet());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
}
