import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { SentryModule } from '@sentry/nestjs/setup';
import { ClsModule } from 'nestjs-cls';
import { PinoLogger } from 'nestjs-pino';
import { AuthVerifierModule } from '@jcool/auth-verifier';
import { ConfigModule } from '@shared/config';
import { authVerifierOptions } from '@shared/auth/auth-verifier-options.factory';
import { SessionStateModule } from '@shared/auth/session-state.module';
import { DrizzleModule } from '@shared/infrastructure/database';
import * as schema from '@shared/infrastructure/database/schema';
import { RedisDurabilityCheck, RedisModule } from '@jcool/platform/redis';
import { MessagingModule } from '@shared/messaging';
import { RetentionModule } from '@jcool/platform/retention';
import { ThrottlerSecurityModule } from '@jcool/platform/throttler';
import { HealthModule } from '@jcool/platform/health';
import { CanonicalLogInterceptor, ObservabilityLoggerModule, clsModuleOptions } from '@jcool/platform/observability';
import { MetricsModule } from '@jcool/platform/metrics';
import { HttpExceptionFilter } from '@jcool/platform/interface';
import { DebugController } from '@shared/interface/controllers/debug.controller';
import { CatalogModule } from '@modules/catalog/catalog.module';
import { CartModule } from '@modules/cart/cart.module';
import { InventoryModule } from '@modules/inventory/inventory.module';
import { MediaModule } from '@modules/media/media.module';
import { OrderModule } from '@modules/order/order.module';
import { PaymentModule } from '@modules/payment/payment.module';

// ClsModule precedes ObservabilityLoggerModule so its correlation middleware mounts before pino;
// ThrottlerSecurityModule precedes AuthVerifierModule: global guards run in module-scan order.
// SentryModule only adds a route-name interceptor — Sentry itself is initialized in instrumentation.ts.
@Module({
  imports: [
    ConfigModule,
    ClsModule.forRoot(clsModuleOptions),
    ObservabilityLoggerModule,
    MetricsModule,
    SentryModule.forRoot(),
    DrizzleModule.forRoot({ schema }),
    RedisModule,
    // @Global, so position is readability only: a complete sweep roster is guaranteed by
    // registration happening in onModuleInit while the scheduler waits for onApplicationBootstrap.
    RetentionModule,
    MessagingModule,
    ThrottlerSecurityModule,
    AuthVerifierModule.forRootAsync({
      imports: [SessionStateModule],
      inject: [ConfigService, PinoLogger],
      useFactory: authVerifierOptions,
    }),
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
    RedisDurabilityCheck,
    { provide: APP_INTERCEPTOR, useClass: CanonicalLogInterceptor },
    // Registered via DI, not useGlobalFilters, so the filter can inject CLS.
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
  ],
})
export class AppModule {}
