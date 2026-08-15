// OpenTelemetry + Sentry preload — load via `node --import ./dist/instrumentation.js` before the
// app so auto-instrumentation can patch pg/ioredis/http as they load. Reads raw process.env (runs
// before Nest's ConfigModule). OTel is a no-op unless OTEL_ENABLED=true; Sentry is a no-op unless
// SENTRY_DSN is set. See ADR-0015 (tracing) and ADR-0016 (Sentry coexists on the same OTel SDK).
import * as Sentry from '@sentry/nestjs';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { scrubPii } from './shared/observability/error-tracking/scrub-pii';

// A positive fraction turns on Sentry performance spans; 0/absent → errors only. Mapped to undefined
// (not literal 0) on purpose: an explicit 0 still flips Sentry's own http-span instrumentation on
// (hasSpansEnabled), which would duplicate our OTel http.server spans in Jaeger.
function resolveTracesSampleRate(raw: string | undefined): number | undefined {
  const rate = Number(raw);
  return Number.isFinite(rate) && rate > 0 ? rate : undefined;
}

const sentryEnabled = Boolean(process.env.SENTRY_DSN);

// Init Sentry BEFORE the OTel SDK (and before Nest) so its http patch and event-context-trace hook
// are in place first. skipOpenTelemetrySetup: reuse the OTel SDK below instead of Sentry building
// its own (which would double-init and break/duplicate spans).
if (sentryEnabled) {
  const tracesSampleRate = resolveTracesSampleRate(process.env.SENTRY_TRACES_SAMPLE_RATE);
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV,
    skipOpenTelemetrySetup: true,
    ...(tracesSampleRate !== undefined ? { tracesSampleRate } : {}),
    // Our OTel SDK owns span emission and W3C propagation; keep Sentry from emitting its own
    // http.server spans or injecting sentry-trace headers even if the sample rate is later raised.
    integrations: [Sentry.httpIntegration({ spans: false, tracePropagation: false })],
    beforeSend: scrubPii,
  });
}

if (process.env.OTEL_ENABLED === 'true') {
  const serviceName = process.env.OTEL_SERVICE_NAME ?? 'jcool-api';
  // OTLP/HTTP base endpoint; the Collector fans out to Jaeger and redacts PII.
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318';

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName }),
    traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
    // Sentry's context manager is a strict superset of AsyncLocalStorage: it augments the OTel
    // context with Sentry scopes (so error events pick up the active traceId → native trace link,
    // and per-request scope can't cross-contaminate concurrent requests) then delegates to normal
    // OTel propagation. Attached only when Sentry is on, so OTel-only runs stay unchanged. We keep
    // the default sampler/propagator: SentrySampler would drop all spans at rate 0 and starve the
    // Jaeger export; SentryPropagator would replace W3C traceparent and break the cross-process seam.
    ...(sentryEnabled ? { contextManager: new Sentry.SentryContextManager() } : {}),
    instrumentations: [
      getNodeAutoInstrumentations({
        // fs spans are noise for an HTTP service.
        '@opentelemetry/instrumentation-fs': { enabled: false },
        // pino gets traceId/spanId from our own mixin (logger.module); avoid a second path.
        '@opentelemetry/instrumentation-pino': { enabled: false },
        // Core pillars: HTTP server span → pg → ioredis.
        '@opentelemetry/instrumentation-http': { enabled: true },
        '@opentelemetry/instrumentation-express': { enabled: true },
        '@opentelemetry/instrumentation-pg': { enabled: true },
        '@opentelemetry/instrumentation-ioredis': { enabled: true },
      }),
    ],
  });

  sdk.start();

  // Flush buffered spans (and any in-flight Sentry events) on shutdown; Nest (enableShutdownHooks)
  // owns process exit, so don't call process.exit() here — it would race the pool/Redis drain.
  const flush = (): void => {
    void sdk.shutdown().catch(() => undefined);
    if (sentryEnabled) void Sentry.flush(2000).catch(() => undefined);
  };
  process.once('SIGTERM', flush);
  process.once('SIGINT', flush);
} else if (sentryEnabled) {
  // Sentry on, OTel off (errors captured without trace linkage — degraded, not broken): still flush
  // pending events on shutdown.
  const flush = (): void => {
    void Sentry.flush(2000).catch(() => undefined);
  };
  process.once('SIGTERM', flush);
  process.once('SIGINT', flush);
}
