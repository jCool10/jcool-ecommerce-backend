import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { collectDefaultMetrics, register } from 'prom-client';
import { BusinessMetrics } from './business.metrics';
import { HttpMetricsInterceptor } from './http-metrics.interceptor';
import { METRIC_PROVIDERS } from './metric-definitions';
import { MetricsController } from './metrics.controller';
import { MetricsTokenGuard } from './metrics.guard';
import { METRICS } from './metrics.port';

// Node/process default metrics. Guarded so a second import (e.g. e2e builds several Nest apps
// in one process) is idempotent instead of throwing "already registered".
if (!register.getSingleMetric('process_cpu_seconds_total')) {
  collectDefaultMetrics();
}

/**
 * Metrics pillar (ADR-0014). Global so the `METRICS` port injects anywhere without each module
 * importing it. Registers default + RED + business metrics, the RED interceptor (APP_INTERCEPTOR),
 * and the guarded `/metrics` controller.
 */
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
