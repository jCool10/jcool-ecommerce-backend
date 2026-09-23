import { Logger as NestLogger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { Logger, PinoLogger } from 'nestjs-pino';
import { logProcessCrashes } from '@jcool/platform/observability';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const logger = app.get(Logger);
  app.useLogger(logger);
  logProcessCrashes(await app.resolve(PinoLogger));
  configureApp(app);
  app.enableShutdownHooks();

  const config = app.get(ConfigService);
  const port = config.get<number>('app.port') ?? 3000;
  try {
    // No host: Node binds `::` (dual-stack) where IPv6 exists, which Railway's private network needs.
    await app.listen(port);
  } catch (error) {
    // Init has already leased a node; a crash loop that never hands them back drains the pool.
    await app.close();
    throw error;
  }
  logger.log(
    {
      port,
      env: config.get<string>('app.env'),
      logLevel: config.get<string>('log.level'),
      leaseTtlMs: config.get<number>('lease.ttlMs'),
      leaseRenewEveryMs: config.get<number>('lease.renewEveryMs'),
      leaseQuarantineMs: config.get<number>('lease.quarantineMs'),
      leaseFenceMarginMs: config.get<number>('lease.fenceMarginMs'),
      leaseMaxFloorAheadMs: config.get<number>('lease.maxFloorAheadMs'),
      dbQueryTimeoutMs: config.get<number>('database.queryTimeoutMs'),
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
