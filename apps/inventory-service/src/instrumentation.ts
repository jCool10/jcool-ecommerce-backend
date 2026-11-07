// Preload via `node --import ./dist/instrumentation.js` before the app, so auto-instrumentation can
// patch pg/ioredis/http as they load. Runs before Nest's ConfigModule, hence the raw process.env.
// Same wiring as the api's; see apps/api/src/instrumentation.ts for the reasoning behind each step.
import * as Sentry from '@sentry/nestjs';
import { DiagConsoleLogger, DiagLogLevel, diag } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
// Not the observability barrel: it would load Nest and nestjs-pino before the SDK can patch them.
import { scrubPii } from '@jcool/platform/error-tracking';
import type { TelemetryFlushGlobal } from '@jcool/platform/observability';
import { ScrubbingSpanExporter, autoInstrumentationConfig } from '@jcool/platform/telemetry';

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
  const serviceName = process.env.OTEL_SERVICE_NAME ?? 'jcool-inventory-service';
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318';

  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.WARN);

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName }),
    traceExporter: new ScrubbingSpanExporter(new OTLPTraceExporter({ url: `${endpoint}/v1/traces` })),
    metricReaders: [],
    logRecordProcessors: [],
    ...(sentryEnabled ? { contextManager: new Sentry.SentryContextManager() } : {}),
    instrumentations: [getNodeAutoInstrumentations(autoInstrumentationConfig())],
  });

  sdk.start();

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
