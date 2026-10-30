import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ClsModule } from 'nestjs-cls';
import { PinoLogger } from 'nestjs-pino';
import { AuthVerifierModule } from '@jcool/auth-verifier';
import { SessionStateModule, authVerifierOptions } from '@jcool/auth-verifier/session-state';
import { DrizzleModule } from '@jcool/platform/database';
import { HealthModule } from '@jcool/platform/health';
import { HttpExceptionFilter } from '@jcool/platform/interface';
import { MetricsModule } from '@jcool/platform/metrics';
import { CanonicalLogInterceptor, ObservabilityLoggerModule, clsModuleOptions } from '@jcool/platform/observability';
import { RedisDurabilityCheck, RedisModule } from '@jcool/platform/redis';
import { ThrottlerSecurityModule } from '@jcool/platform/throttler';
import configuration from './config/configuration';
import { validate } from './config/env.validation';
import * as schema from './database/schema';
import { InventoryModule } from './modules/inventory/inventory.module';

// ClsModule precedes the logger so its correlation middleware mounts before pino's.
// ThrottlerSecurityModule precedes AuthVerifierModule: global guards run in module-scan order.
@Module({
  imports: [
    // `node --env-file-if-exists` already loaded .env; reading it again here would let a stray file
    // override what a test or the platform set.
    ConfigModule.forRoot({ isGlobal: true, validate, load: [configuration], ignoreEnvFile: true }),
    ClsModule.forRoot(clsModuleOptions),
    ObservabilityLoggerModule,
    MetricsModule,
    DrizzleModule.forRoot({ schema }),
    RedisModule,
    ScheduleModule.forRoot(),
    ThrottlerSecurityModule,
    AuthVerifierModule.forRootAsync({
      imports: [SessionStateModule],
      inject: [ConfigService, PinoLogger],
      useFactory: authVerifierOptions,
    }),
    HealthModule,
    InventoryModule,
  ],
  providers: [
    // The admin routes read auth:* there, so an evicting Redis would bring revoked sessions back.
    RedisDurabilityCheck,
    { provide: APP_INTERCEPTOR, useClass: CanonicalLogInterceptor },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
  ],
})
export class AppModule {}
