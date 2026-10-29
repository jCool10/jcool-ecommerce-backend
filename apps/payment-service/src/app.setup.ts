import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';

/** What main.ts adds on top of the module graph, shared so the e2e app is the one that ships. */
export function configureApp(app: NestExpressApplication): void {
  const config = app.get(ConfigService);

  // Only for the access log's client address: nothing here is throttled or keyed on `req.ip`.
  const trustProxy = config.get<boolean | number | string>('app.trustProxy');
  if (trustProxy !== false) {
    app.set('trust proxy', trustProxy);
  }

  // No browser calls this service: Stripe posts the webhook, the api calls the rest.
  app.use(helmet());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
}
