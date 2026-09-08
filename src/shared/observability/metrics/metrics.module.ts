import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { collectDefaultMetrics, register } from 'prom-client';
import { BusinessMetrics } from './business.metrics';
import { HttpMetricsInterceptor } from './http-metrics.interceptor';
import { METRIC_PROVIDERS } from './metric-definitions';
import { MetricsController } from './metrics.controller';
import { MetricsTokenGuard } from './metrics.guard';
import { METRICS } from './metrics.port';

// Guarded so a second import is idempotent instead of throwing "already registered": e2e builds
// several Nest apps in one process.
if (!register.getSingleMetric('process_cpu_seconds_total')) {
  collectDefaultMetrics();
}

@Global()
@Module({
  controllers: [MetricsController],
  providers: [
    MetricsTokenGuard,
    ...METRIC_PROVIDERS,
    { provide: METRICS, useClass: BusinessMetrics },
    { provide: APP_INTERCEPTOR, useClass: HttpMetricsInterceptor },
  ],
  exports: [METRICS],
})
export class MetricsModule {}
