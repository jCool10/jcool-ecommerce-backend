import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { collectDefaultMetrics, register } from 'prom-client';
import { BusinessMetrics } from './business.metrics';
import { HttpMetricsInterceptor } from './http-metrics.interceptor';
import { METRIC_PROVIDERS } from './metric-definitions';
import { MetricsController } from './metrics.controller';
import { MetricsTokenGuard } from './metrics.guard';
import { METRICS } from './metrics.port';

// Node/process default metrics (process_*, nodejs_eventloop_lag_seconds = saturation, heap).
// Registered once per process: module evaluation is cached by Node, and the guard makes a
// second import idempotent instead of throwing "already registered" (matters for e2e, which
// builds several Nest apps in one process against this global registry).
if (!register.getSingleMetric('process_cpu_seconds_total')) {
  collectDefaultMetrics();
}

/**
 * Metrics pillar (ADR-0014). Global so the cross-cutting `METRICS` port injects into any
 * context (order/cart/auth) without each feature module importing this. Registers default +
 * RED + business metrics, the RED interceptor (global via APP_INTERCEPTOR), and the guarded
 * `/metrics` controller. prom-client's registry is the process-global one, so metrics survive
 * independently of this module — removing it doesn't touch the request path (rollback-safe).
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
