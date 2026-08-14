import { isSpanContextValid, trace } from '@opentelemetry/api';

/**
 * The active span's trace id, or undefined when tracing is off / outside a span. The log↔trace
 * join key — kept distinct from the client-facing requestId (see getCorrelationId). See ADR-0015.
 */
export function getActiveTraceId(): string | undefined {
  const spanContext = trace.getActiveSpan()?.spanContext();
  return spanContext && isSpanContextValid(spanContext) ? spanContext.traceId : undefined;
}
