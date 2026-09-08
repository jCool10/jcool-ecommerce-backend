import { type Context, context, propagation } from '@opentelemetry/api';

// W3C `traceparent` carried across processes: the outbox writer injects on append, the consumer
// extracts so its spans nest under the producer's trace. scripts/trace-harness.ts demos the loop.

export function injectTraceContext(carrier: Record<string, string> = {}): Record<string, string> {
  propagation.inject(context.active(), carrier);
  return carrier;
}

export function extractTraceContext(carrier: Record<string, string>): Context {
  return propagation.extract(context.active(), carrier);
}
