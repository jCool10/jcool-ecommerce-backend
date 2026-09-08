import { isSpanContextValid, trace } from '@opentelemetry/api';

/** The log↔trace join key — kept distinct from the client-facing requestId (see getCorrelationId). */
export function getActiveTraceId(): string | undefined {
  const spanContext = trace.getActiveSpan()?.spanContext();
  return spanContext && isSpanContextValid(spanContext) ? spanContext.traceId : undefined;
}
