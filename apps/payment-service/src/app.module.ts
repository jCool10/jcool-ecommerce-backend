import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ClsModule } from 'nestjs-cls';
import { MessagingModule } from '@jcool/messaging';
import { DrizzleModule } from '@jcool/platform/database';
import { HealthModule } from '@jcool/platform/health';
import { HttpExceptionFilter } from '@jcool/platform/interface';
import { MetricsModule } from '@jcool/platform/metrics';
import { CanonicalLogInterceptor, ObservabilityLoggerModule, clsModuleOptions } from '@jcool/platform/observability';
import { RedisModule } from '@jcool/platform/redis';
import { RetentionModule } from '@jcool/platform/retention';
import configuration from './config/configuration';
import { validate } from './config/env.validation';
import * as schema from './database/schema';
import { PAYMENT_EVENT_ROUTES } from './messaging/event-routes';
import { ID_GENERATOR } from './modules/payment/application/ports/id-generator.port';
import { IdentityModule } from './modules/payment/identity.module';
import { PaymentModule } from './modules/payment/payment.module';

// ClsModule precedes the logger so its correlation middleware mounts before pino's. No throttler and
// no user auth: Stripe and the order-service are the only callers, and each proves itself on its own route.
@Module({
  imports: [
    // `node --env-file-if-exists` already loaded .env; reading it again here would let a stray file
    // override what a test or the platform set.
    ConfigModule.forRoot({ isGlobal: true, validate, load: [configuration], ignoreEnvFile: true }),
    ClsModule.forRoot(clsModuleOptions),
    ObservabilityLoggerModule,
    MetricsModule,
    DrizzleModule.forRoot({ schema }),
    // The relay's Redis; readiness checks it, since an outage stops payment.authorized at the outbox.
    RedisModule,
    ScheduleModule.forRoot(),
    HealthModule,
    RetentionModule,
    MessagingModule.forRoot({
      routes: PAYMENT_EVENT_ROUTES,
      queues: [],
      idGenerator: ID_GENERATOR,
      imports: [IdentityModule],
    }),
    PaymentModule,
  ],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: CanonicalLogInterceptor },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
  ],
})
export class AppModule {}
