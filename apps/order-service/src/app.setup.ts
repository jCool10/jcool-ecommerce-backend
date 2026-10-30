import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, type OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { swaggerContentSecurityPolicy } from '@jcool/platform/interface';

/** What main.ts adds on top of the module graph, shared so the e2e app is the one that ships. */
export function configureApp(app: NestExpressApplication): void {
  const config = app.get(ConfigService);

  // `req.ip` keys the IP throttle tiers, so it stays off unless the deployment names its proxies.
  const trustProxy = config.get<boolean | number | string>('app.trustProxy');
  if (trustProxy !== false) {
    app.set('trust proxy', trustProxy);
  }

  const swaggerEnabled = config.get<boolean>('app.swaggerEnabled');
  app.use(helmet({ contentSecurityPolicy: swaggerEnabled ? swaggerContentSecurityPolicy : undefined }));

  // The browser-facing /orders routes moved here unchanged, CORS included: the api's policy, verbatim.
  const corsOrigins = config.get<string[]>('app.corsOrigins') ?? [];
  app.enableCors({
    origin: corsOrigins.length > 0 ? corsOrigins : false,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
}

export function createOpenApiDocument(app: NestExpressApplication): OpenAPIObject {
  const swaggerConfig = new DocumentBuilder()
    .setTitle('JCool Order Service')
    .setDescription(
      'Checkout and orders. The order, not the cart, is the source of truth for a transaction: stock is held by the inventory-service, the money by the payment-service.',
    )
    .addBearerAuth()
    .build();
  return SwaggerModule.createDocument(app, swaggerConfig);
}
