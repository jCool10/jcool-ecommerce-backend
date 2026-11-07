import type { IncomingMessage } from 'node:http';
import type { InstrumentationConfigMap } from '@opentelemetry/auto-instrumentations-node';
import { ExpressLayerType } from '@opentelemetry/instrumentation-express';

// Probes and scrapes arrive every few seconds per service; a trace each would bury the real ones.
// Ignoring the request also suppresses the database and Redis spans of the checks it runs.
function isProbeOrScrape(request: IncomingMessage): boolean {
  const [path] = (request.url ?? '').split('?', 1);
  return path === '/metrics' || path === '/health' || path.startsWith('/health/');
}

// Key arguments hold client IPs and email hashes, and BullMQ's scripts carry job payloads.
const commandNameOnly = (command: string): string => command;

/** The auto-instrumentation every exporting preload starts. */
export function autoInstrumentationConfig(): InstrumentationConfigMap {
  return {
    // fs spans are noise for an HTTP service.
    '@opentelemetry/instrumentation-fs': { enabled: false },
    // pino gets traceId/spanId from the platform logger's mixin; avoid a second path.
    '@opentelemetry/instrumentation-pino': { enabled: false },
    // Neither asks for a parent, so every pool or Redis reconnect would open a trace of its own.
    '@opentelemetry/instrumentation-dns': { enabled: false },
    '@opentelemetry/instrumentation-net': { enabled: false },
    '@opentelemetry/instrumentation-http': {
      enabled: true,
      ignoreIncomingRequestHook: isProbeOrScrape,
      requireParentforOutgoingSpans: true,
    },
    // A middleware layer records body-parser's error, whose message quotes the request body.
    '@opentelemetry/instrumentation-express': { enabled: true, ignoreLayersType: [ExpressLayerType.MIDDLEWARE] },
    // Express 5 dispatches through the `router` package, whose instrumentation spans every middleware
    // layer again and repeats express's request-handler spans.
    '@opentelemetry/instrumentation-router': { enabled: false },
    // fetch: carries `traceparent` to the other services.
    '@opentelemetry/instrumentation-undici': { enabled: true, requireParentforSpans: true },
    // Without a parent, every outbox poll and queue pop would start a trace of its own. A scheduler
    // tick runs inside a span, so it is a trace, with its queries.
    '@opentelemetry/instrumentation-pg': { enabled: true, requireParentSpan: true },
    '@opentelemetry/instrumentation-ioredis': {
      enabled: true,
      requireParentSpan: true,
      dbStatementSerializer: commandNameOnly,
    },
  };
}
