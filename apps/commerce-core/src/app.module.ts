import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { SentryModule } from '@sentry/nestjs/setup';
import { ClsModule } from 'nestjs-cls';
import { AuthVerifyModule } from '@shared/auth';
import { ConfigModule } from '@shared/config';
import { DrizzleModule } from '@shared/infrastructure/database';
import { RedisModule } from '@shared/infrastructure/redis';
import { MessagingModule } from '@shared/messaging';
import { RetentionModule } from '@shared/retention';
import { ThrottlerSecurityModule } from '@shared/infrastructure/throttler';
import { HealthModule } from '@shared/health';
import { CanonicalLogInterceptor, ObservabilityLoggerModule, clsModuleOptions } from '@shared/observability';
import { MetricsModule } from '@shared/observability/metrics/metrics.module';
import { HttpExceptionFilter } from '@shared/interface/filters/http-exception.filter';
import { DebugController } from '@shared/interface/controllers/debug.controller';
import { CatalogModule } from '@modules/catalog/catalog.module';
import { CartModule } from '@modules/cart/cart.module';
import { InventoryModule } from '@modules/inventory/inventory.module';
import { MediaModule } from '@modules/media/media.module';
import { OrderModule } from '@modules/order/order.module';
import { PaymentModule } from '@modules/payment/payment.module';
import * as schema from './database/schema';
import { CommerceMessagingModule } from './messaging/commerce-messaging.module';

// ClsModule precedes ObservabilityLoggerModule so its correlation middleware mounts before pino;
// ThrottlerSecurityModule precedes AuthVerifyModule so its rate-limit guard runs before the auth
// guards. SentryModule only adds a route-name interceptor — Sentry itself is initialized in
// instrumentation.ts. No user code: identity is a signed token this app verifies and never issues.
@Module({
  imports: [
    ConfigModule.forRoot(),
    ClsModule.forRoot(clsModuleOptions),
    ObservabilityLoggerModule,
    MetricsModule,
    SentryModule.forRoot(),
    DrizzleModule.forRoot(schema),
    RedisModule,
    // @Global, so position is readability only: a complete sweep roster is guaranteed by
    // registration happening in onModuleInit while the scheduler waits for onApplicationBootstrap.
    RetentionModule,
    MessagingModule,
    // Supplies MessagingModule's two dispatch tokens. Listed after it for readability only —
    // both are @Global, so neither imports the other and registration order carries no meaning.
    CommerceMessagingModule,
    ThrottlerSecurityModule,
    // Verification only — a public key and Redis. Issuing lives in AuthModule below.
    AuthVerifyModule,
    ScheduleModule.forRoot(),
    HealthModule,
    CatalogModule,
    CartModule,
    InventoryModule,
    // Position carries no meaning here: Catalog reaches Media through MEDIA_FACADE in the DI graph.
    MediaModule,
    OrderModule,
    PaymentModule,
  ],
  controllers: [DebugController],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: CanonicalLogInterceptor },
    // Registered via DI, not useGlobalFilters, so the filter can inject CLS.
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
  ],
})
export class AppModule {}
