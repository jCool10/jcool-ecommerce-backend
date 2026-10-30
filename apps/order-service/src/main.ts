import { Logger as NestLogger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { SwaggerModule } from '@nestjs/swagger';
import { Logger, PinoLogger } from 'nestjs-pino';
import { logProcessCrashes } from '@jcool/platform/observability';
import { AppModule } from './app.module';
import { configureApp, createOpenApiDocument } from './app.setup';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  const logger = app.get(Logger);
  app.useLogger(logger);
  logProcessCrashes(await app.resolve(PinoLogger));
  configureApp(app);
  app.enableShutdownHooks();

  const config = app.get(ConfigService);
  const swaggerEnabled = config.get<boolean>('app.swaggerEnabled');
  if (swaggerEnabled) {
    SwaggerModule.setup('docs', app, createOpenApiDocument(app));
  }

  const port = config.get<number>('app.port') ?? 3000;
  // No host: Node binds `::` (dual-stack) where IPv6 exists, which Railway's private network needs.
  await app.listen(port);
  logger.log(
    {
      port,
      env: config.get<string>('app.env'),
      logLevel: config.get<string>('log.level'),
      swaggerEnabled,
      queueWorkerEnabled: config.get<boolean>('queue.workerEnabled'),
      relayEnabled: config.get<boolean>('outbox.relayEnabled'),
      temporalWorkerEnabled: config.get<boolean>('checkoutSaga.temporal.workerEnabled'),
      temporalTaskQueue: config.get<string>('checkoutSaga.temporal.taskQueue'),
    },
    'application started',
    'Bootstrap',
  );
}

void bootstrap().catch((error: unknown) => {
  NestLogger.error(error instanceof Error ? (error.stack ?? error.message) : String(error), undefined, 'Bootstrap');
  NestLogger.flush();
  process.exit(1);
});
