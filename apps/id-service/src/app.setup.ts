import { type INestApplication, ValidationPipe } from '@nestjs/common';

/** What main.ts adds on top of the module graph, shared so the e2e app is the one that ships. */
export function configureApp(app: INestApplication): void {
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
}
