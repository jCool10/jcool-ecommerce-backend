import { ConfigService } from '@nestjs/config';
import { ClsService } from 'nestjs-cls';
import { LoggerModule } from 'nestjs-pino';
import { createLoggerParams } from './logger-params';

/**
 * autoLogging is OFF on purpose — {@link CanonicalLogInterceptor} owns the single completion line.
 */
export const ObservabilityLoggerModule = LoggerModule.forRootAsync({
  inject: [ConfigService, ClsService],
  useFactory: createLoggerParams,
});
