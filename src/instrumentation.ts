// Preload via `node --import ./dist/instrumentation.js` before the app, so auto-instrumentation can
// patch pg/ioredis/http as they load. Runs before Nest's ConfigModule, hence the raw process.env.
import * as Sentry from '@sentry/nestjs';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { scrubPii } from './shared/observability/error-tracking/scrub-pii';
import type { TelemetryFlushGlobal } from './shared/observability/telemetry-flush.service';

const sentryEnabled = Boolean(process.env.SENTRY_DSN);

// Init Sentry BEFORE the OTel SDK (and before Nest) so its http patch and event-context-trace hook
// are in place first. skipOpenTelemetrySetup stops it building a second SDK, so Sentry receives
// errors only — hence deliberately no performance-sampling knob: a rate cannot reach unseen spans.
if (sentryEnabled) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV,
    skipOpenTelemetrySetup: true,
    // Our OTel SDK owns span emission and W3C propagation; keep Sentry from emitting its own
    // http.server spans or injecting sentry-trace headers.
    integrations: [Sentry.httpIntegration({ spans: false, tracePropagation: false })],
    beforeSend: scrubPii,
  });
}

// Nest holds the signal until the flush resolves, and a blackholed OTLP endpoint (the collector
// terminating in the same rollout) costs the exporter's 10s timeout plus Sentry's 2s — on top of a
// 5s readiness grace, enough to turn a clean exit into a SIGKILL. A healthy flush needs milliseconds.
const FLUSH_TIMEOUT_MS = 3000;

// Awaited by TelemetryFlushService from Nest's onApplicationShutdown, never on the signal itself:
// the process keeps serving through the readiness grace period, and shutting the exporter down at
// the start of that window drops exactly the traces and errors a rollout needs.
function publishTelemetryFlush(flush: () => Promise<void>): void {
  // unref'd so the ceiling itself never holds the event loop open once the flush has won the race.
  (globalThis as TelemetryFlushGlobal).__flushTelemetry = () =>
    Promise.race([flush(), new Promise<void>((resolve) => setTimeout(resolve, FLUSH_TIMEOUT_MS).unref())]);
}

if (process.env.OTEL_ENABLED === 'true') {
  const serviceName = process.env.OTEL_SERVICE_NAME ?? 'jcool-api';
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318';

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName }),
    traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
    // Sentry's context manager is a strict superset of AsyncLocalStorage: it adds Sentry scopes (so
    // error events pick up the active traceId) then delegates to normal OTel propagation. It is the
    // only piece of Sentry's tracing pipeline wired in — a Sentry span processor and sampler would
    // fight the OTel sampler and the W3C propagation seam this export depends on.
    ...(sentryEnabled ? { contextManager: new Sentry.SentryContextManager() } : {}),
    instrumentations: [
      getNodeAutoInstrumentations({
        // fs spans are noise for an HTTP service.
        '@opentelemetry/instrumentation-fs': { enabled: false },
        // pino gets traceId/spanId from our own mixin (logger.module); avoid a second path.
        '@opentelemetry/instrumentation-pino': { enabled: false },
        '@opentelemetry/instrumentation-http': { enabled: true },
        '@opentelemetry/instrumentation-express': { enabled: true },
        '@opentelemetry/instrumentation-pg': { enabled: true },
        '@opentelemetry/instrumentation-ioredis': { enabled: true },
      }),
    ],
  });

  sdk.start();

  publishTelemetryFlush(async () => {
    // Concurrent, not chained: the ceiling below races the whole closure, so awaiting the OTLP
    // shutdown first would spend the entire budget on a dead collector and never reach Sentry —
    // losing the errors from the drain window. Neither flush depends on the other's ordering.
    await Promise.all([
      sdk.shutdown().catch(() => undefined),
      sentryEnabled ? Sentry.flush(2000).catch(() => undefined) : Promise.resolve(),
    ]);
  });
} else if (sentryEnabled) {
  // Sentry on, OTel off: errors are captured without trace linkage — degraded, not broken.
  publishTelemetryFlush(async () => {
    await Sentry.flush(2000).catch(() => undefined);
  });
}
