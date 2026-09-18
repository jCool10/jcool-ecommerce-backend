import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { collectDefaultMetrics, register } from 'prom-client';
import { BusinessMetrics } from './business.metrics';
import { HttpMetricsInterceptor } from './http-metrics.interceptor';
import { BUSINESS_METRIC_PROVIDERS, HTTP_METRIC_PROVIDERS } from './metric-definitions';
import { MetricsController } from './metrics.controller';
import { MetricsTokenGuard } from './metrics.guard';
import { METRICS } from '@jcool/metrics-port';
import { TelemetryFlushService } from '../telemetry-flush.service';

// Guarded so a second import is idempotent instead of throwing "already registered": e2e builds
// several Nest apps in one process.
if (!register.getSingleMetric('process_cpu_seconds_total')) {
  collectDefaultMetrics();
}

/** `/metrics`, process and RED metrics: what every service exposes, with none of the api's domain series. */
@Global()
@Module({
  controllers: [MetricsController],
  providers: [
    MetricsTokenGuard,
    // Hosted here because this is the observability module the root module already imports; it only
    // needs to be instantiated somewhere global so Nest calls its shutdown hook.
    TelemetryFlushService,
    ...HTTP_METRIC_PROVIDERS,
    { provide: APP_INTERCEPTOR, useClass: HttpMetricsInterceptor },
  ],
})
export class HttpMetricsModule {}

@Global()
@Module({
  imports: [HttpMetricsModule],
  providers: [...BUSINESS_METRIC_PROVIDERS, { provide: METRICS, useClass: BusinessMetrics }],
  exports: [METRICS],
})
export class MetricsModule {}
