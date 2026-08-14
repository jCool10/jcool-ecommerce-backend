// OpenTelemetry preload — load via `node --import ./dist/instrumentation.js` before the app
// so auto-instrumentation can patch pg/ioredis/http as they load. Reads raw process.env
// (runs before Nest's ConfigModule); no-op unless OTEL_ENABLED=true. See ADR-0015.
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

if (process.env.OTEL_ENABLED === 'true') {
  const serviceName = process.env.OTEL_SERVICE_NAME ?? 'jcool-api';
  // OTLP/HTTP base endpoint; the Collector fans out to Jaeger and redacts PII.
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318';

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName }),
    traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
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

  // Flush buffered spans on shutdown; Nest (enableShutdownHooks) owns process exit, so don't
  // call process.exit() here — it would race the pool/Redis drain.
  const flushSpans = (): void => {
    void sdk.shutdown().catch(() => undefined);
  };
  process.once('SIGTERM', flushSpans);
  process.once('SIGINT', flushSpans);
}
