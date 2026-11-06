// Preload via `node --import ./dist/instrumentation.js` before the app, so auto-instrumentation can
// patch pg/ioredis/http/undici as they load. Runs before Nest's ConfigModule, hence the raw process.env.
// Same wiring as the api's; see apps/api/src/instrumentation.ts for the reasoning behind each step.
import * as Sentry from '@sentry/nestjs';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
// Not the observability barrel: it would load Nest and nestjs-pino before the SDK can patch them.
import { scrubPii } from '@jcool/platform/error-tracking';
import type { TelemetryFlushGlobal } from '@jcool/platform/observability';
import type { WorkflowSpanExportGlobal } from './modules/order/infrastructure/temporal/workflow-tracing';
import { telemetryResource } from './telemetry-resource';

const sentryEnabled = Boolean(process.env.SENTRY_DSN);

if (sentryEnabled) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV,
    skipOpenTelemetrySetup: true,
    integrations: [Sentry.httpIntegration({ spans: false, tracePropagation: false })],
    beforeSend: scrubPii,
  });
}

// Inside the readiness grace, so a blackholed collector cannot turn a clean exit into a SIGKILL.
const FLUSH_TIMEOUT_MS = 3000;

function publishTelemetryFlush(flush: () => Promise<void>): void {
  (globalThis as TelemetryFlushGlobal).__flushTelemetry = () =>
    Promise.race([
      flush().then(() => 'flushed' as const),
      new Promise<'timed_out'>((resolve) => setTimeout(() => resolve('timed_out'), FLUSH_TIMEOUT_MS).unref()),
    ]);
}

if (process.env.OTEL_ENABLED === 'true') {
  const serviceName = process.env.OTEL_SERVICE_NAME ?? 'jcool-order-service';
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318';

  const resource = telemetryResource(serviceName);
  const spanProcessor = new BatchSpanProcessor(new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }));

  const sdk = new NodeSDK({
    resource,
    autoDetectResources: false,
    spanProcessors: [spanProcessor],
    ...(sentryEnabled ? { contextManager: new Sentry.SentryContextManager() } : {}),
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false },
        // pino gets traceId/spanId from the platform logger's mixin.
        '@opentelemetry/instrumentation-pino': { enabled: false },
        '@opentelemetry/instrumentation-http': { enabled: true },
        '@opentelemetry/instrumentation-express': { enabled: true },
        // fetch: carries `traceparent` to the api, inventory-, payment-, user- and id-service.
        '@opentelemetry/instrumentation-undici': { enabled: true },
        '@opentelemetry/instrumentation-pg': { enabled: true },
        '@opentelemetry/instrumentation-ioredis': { enabled: true },
      }),
    ],
  });

  sdk.start();
  // Workflow spans are made in the Temporal sandbox and reach Node through a sink; the worker hands
  // them to this processor.
  (globalThis as WorkflowSpanExportGlobal).__workflowSpanExport = { spanProcessor, resource };

  publishTelemetryFlush(async () => {
    await Promise.all([
      sdk.shutdown().catch(() => undefined),
      sentryEnabled ? Sentry.flush(2000).catch(() => undefined) : Promise.resolve(),
    ]);
  });
} else if (sentryEnabled) {
  publishTelemetryFlush(async () => {
    await Sentry.flush(2000).catch(() => undefined);
  });
}
