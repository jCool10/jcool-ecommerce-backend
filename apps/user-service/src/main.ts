import { Logger as NestLogger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger, PinoLogger } from 'nestjs-pino';
import { logProcessCrashes } from '@jcool/platform/observability';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  const logger = app.get(Logger);
  app.useLogger(logger);
  logProcessCrashes(await app.resolve(PinoLogger));
  configureApp(app);
  app.enableShutdownHooks();

  const config = app.get(ConfigService);
  const port = config.get<number>('app.port') ?? 3000;
  // No host: Node binds `::` (dual-stack) where IPv6 exists, which Railway's private network needs.
  await app.listen(port);
  logger.log(
    {
      port,
      env: config.get<string>('app.env'),
      logLevel: config.get<string>('log.level'),
      swaggerEnabled: config.get<boolean>('app.swaggerEnabled'),
      requireVerifiedEmail: config.get<boolean>('auth.requireVerifiedEmail'),
      jwtAccessTtl: config.get<string>('auth.jwtAccessTtl'),
      refreshTokenTtl: config.get<string>('auth.refreshTokenTtl'),
      emailVerificationTtl: config.get<string>('auth.emailVerificationTtl'),
      passwordResetTtl: config.get<string>('auth.passwordResetTtl'),
      identityPinBootstrap: config.get<boolean>('identity.pinBootstrap'),
      sessionEpochReconcileEnabled: config.get<boolean>('sessionEpoch.reconcileEnabled'),
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
