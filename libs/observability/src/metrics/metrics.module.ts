import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { collectDefaultMetrics, register } from 'prom-client';
import { BusinessMetrics } from './business.metrics';
import { HttpMetricsInterceptor } from './http-metrics.interceptor';
import { METRIC_PROVIDERS } from './metric-definitions';
import { MetricsController } from './metrics.controller';
import { MetricsTokenGuard } from './metrics.guard';
import { METRICS } from './metrics.port';
import { TelemetryFlushService } from '../telemetry-flush.service';

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
    // Hosted here because this is the observability module the root module already imports; it only
    // needs to be instantiated somewhere global so Nest calls its shutdown hook.
    TelemetryFlushService,
    ...METRIC_PROVIDERS,
    { provide: METRICS, useClass: BusinessMetrics },
    { provide: APP_INTERCEPTOR, useClass: HttpMetricsInterceptor },
  ],
  exports: [METRICS],
})
export class MetricsModule {}
