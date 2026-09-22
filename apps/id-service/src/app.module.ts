import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { ClsModule } from 'nestjs-cls';
import { DrizzleModule } from '@jcool/platform/database';
import { HttpExceptionFilter } from '@jcool/platform/interface';
import { HttpMetricsModule } from '@jcool/platform/metrics';
import { CanonicalLogInterceptor, ObservabilityLoggerModule, clsModuleOptions } from '@jcool/platform/observability';
import configuration from './config/configuration';
import { validate } from './config/env.validation';
import * as schema from './database/schema';
import { HealthModule } from './health/health.module';
import { MintModule } from './mint/mint.module';

// ClsModule precedes the logger so its correlation middleware mounts before pino's.
@Module({
  imports: [
    // `node --env-file-if-exists` already loaded .env; reading it again here would let a stray file
    // override what a test or the platform set.
    ConfigModule.forRoot({ isGlobal: true, validate, load: [configuration], ignoreEnvFile: true }),
    ClsModule.forRoot(clsModuleOptions),
    ObservabilityLoggerModule,
    HttpMetricsModule,
    DrizzleModule.forRoot({ schema }),
    MintModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: CanonicalLogInterceptor },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
  ],
})
export class AppModule {}
