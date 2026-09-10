import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { SentryModule } from '@sentry/nestjs/setup';
import { ClsModule } from 'nestjs-cls';
import { AuthVerifyModule } from '@shared/auth';
import { UserConfigModule } from '@shared/config';
import { DrizzleModule } from '@shared/infrastructure/database';
import { RedisModule } from '@shared/infrastructure/redis';
import { RetentionModule } from '@shared/retention';
import { ThrottlerSecurityModule } from '@shared/infrastructure/throttler';
import { HealthModule } from '@shared/health';
import { CanonicalLogInterceptor, ObservabilityLoggerModule, clsModuleOptions } from '@shared/observability';
import { MetricsModule } from '@shared/observability/metrics/metrics.module';
import { HttpExceptionFilter } from '@shared/interface/filters/http-exception.filter';
import { UserModule } from './modules/user/user.module';
import { AuthModule } from './modules/user/auth.module';
import * as schema from './database/schema';

/**
 * What this app does NOT import is the point of the split: no MessagingModule, no queue, no outbox
 * relay, no inbox, no catalog, no object storage, no search. user-service has nothing to say to
 * commerce-core — it signs a token and writes two Redis keys, and that is the whole interface.
 *
 * Ordering matches commerce-core: ClsModule before the logger so correlation mounts first, and the
 * throttler before AuthModule so rate limiting runs ahead of the auth guards.
 */
@Module({
  imports: [
    UserConfigModule.forRoot(),
    ClsModule.forRoot(clsModuleOptions),
    ObservabilityLoggerModule,
    MetricsModule,
    SentryModule.forRoot(),
    // Its own instance, named by its own variable: DATABASE_URL belongs to commerce-core, and the
    // e2e harness runs both apps off one process.env.
    DrizzleModule.forRoot(schema, 'database.userUrl'),
    RedisModule,
    RetentionModule,
    ThrottlerSecurityModule,
    // The issuer verifies its own tokens too — /auth/me and /auth/logout are authenticated routes.
    AuthVerifyModule,
    ScheduleModule.forRoot(),
    HealthModule,
    UserModule,
    AuthModule,
  ],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: CanonicalLogInterceptor },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
  ],
})
export class UserAppModule {}
