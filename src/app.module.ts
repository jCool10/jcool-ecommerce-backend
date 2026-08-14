import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { ClsModule } from 'nestjs-cls';
import { ConfigModule } from '@shared/config';
import { DrizzleModule } from '@shared/infrastructure/database';
import { RedisModule } from '@shared/infrastructure/redis';
import { ThrottlerSecurityModule } from '@shared/infrastructure/throttler';
import { HealthModule } from '@shared/health';
import { CanonicalLogInterceptor, ObservabilityLoggerModule, clsModuleOptions } from '@shared/observability';
import { MetricsModule } from '@shared/observability/metrics/metrics.module';
import { HttpExceptionFilter } from '@shared/interface/filters/http-exception.filter';
import { CatalogModule } from '@modules/catalog/catalog.module';
import { CartModule } from '@modules/cart/cart.module';
import { OrderModule } from '@modules/order/order.module';
import { UserModule } from '@modules/user/user.module';
import { AuthModule } from '@modules/user/auth.module';

// Root module: global infrastructure (config, correlation, logging, database, redis) +
// feature modules. ClsModule precedes ObservabilityLoggerModule so its correlation
// middleware mounts before pino; ThrottlerSecurityModule precedes AuthModule so its
// rate-limit guard runs before the auth guards.
@Module({
  imports: [
    ConfigModule,
    ClsModule.forRoot(clsModuleOptions),
    ObservabilityLoggerModule,
    MetricsModule,
    DrizzleModule,
    RedisModule,
    ThrottlerSecurityModule,
    HealthModule,
    CatalogModule,
    CartModule,
    OrderModule,
    UserModule,
    AuthModule,
  ],
  providers: [
    // One canonical "request completed" line per successful request (db.queries et al.).
    { provide: APP_INTERCEPTOR, useClass: CanonicalLogInterceptor },
    // Global error envelope + correlation-aware logging; registered via DI so it can read CLS.
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
  ],
})
export class AppModule {}
