import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { SentryModule } from '@sentry/nestjs/setup';
import { ClsModule } from 'nestjs-cls';
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
import { OrderModule } from '@modules/order/order.module';
import { PaymentModule } from '@modules/payment/payment.module';
import { UserModule } from '@modules/user/user.module';
import { AuthModule } from '@modules/user/auth.module';

// Root module: global infrastructure (config, correlation, logging, database, redis) +
// feature modules. ClsModule precedes ObservabilityLoggerModule so its correlation
// middleware mounts before pino; ThrottlerSecurityModule precedes AuthModule so its
// rate-limit guard runs before the auth guards. SentryModule adds a route-name interceptor for
// error grouping; Sentry itself is initialized in instrumentation.ts (no-op without SENTRY_DSN).
@Module({
  imports: [
    ConfigModule,
    ClsModule.forRoot(clsModuleOptions),
    ObservabilityLoggerModule,
    MetricsModule,
    SentryModule.forRoot(),
    DrizzleModule,
    RedisModule,
    // @Global, so position is readability only. A complete sweep roster is guaranteed by
    // registration happening in onModuleInit while the scheduler waits for onApplicationBootstrap.
    RetentionModule,
    MessagingModule,
    ThrottlerSecurityModule,
    // Timer registry for the outbox relay and every sweep; each is gated by its own kill-switch.
    ScheduleModule.forRoot(),
    HealthModule,
    CatalogModule,
    CartModule,
    InventoryModule,
    OrderModule,
    PaymentModule,
    UserModule,
    AuthModule,
  ],
  controllers: [DebugController],
  providers: [
    // One canonical "request completed" line per successful request (db.queries et al.).
    { provide: APP_INTERCEPTOR, useClass: CanonicalLogInterceptor },
    // Global error envelope + correlation-aware logging; registered via DI so it can read CLS.
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
  ],
})
export class AppModule {}
