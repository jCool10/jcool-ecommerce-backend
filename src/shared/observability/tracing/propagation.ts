import { type Context, context, propagation } from '@opentelemetry/api';

/**
 * Cross-process trace-context helpers (W3C `traceparent`): a producer injects the active
 * context into a message carrier, a consumer extracts it to continue the same trace. Not yet
 * wired to the outbox (table doesn't exist); scripts/trace-harness.ts demos the loop. See ADR-0015.
 */

/** Serialise the active trace context into `carrier` (mutated and returned) for a downstream process. */
export function injectTraceContext(carrier: Record<string, string> = {}): Record<string, string> {
  propagation.inject(context.active(), carrier);
  return carrier;
}

/** Rebuild a trace context from an inbound `carrier` so the consumer's spans nest under the producer's trace. */
export function extractTraceContext(carrier: Record<string, string>): Context {
  return propagation.extract(context.active(), carrier);
}
