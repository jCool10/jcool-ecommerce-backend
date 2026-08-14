import { type Span, SpanStatusCode, trace } from '@opentelemetry/api';

/** Tracer name for hand-rolled business spans (auto-instrumentation owns http/pg/ioredis). */
const TRACER_NAME = 'jcool';

/**
 * Runs `fn` inside an active span (nesting any pg/redis work under it). Use for business spans
 * the auto-instrumentation can't name (e.g. `order.place`). A thrown error is recorded on the
 * span and rethrown; the span always ends. No-op span when OTel is disabled. See ADR-0015.
 */
export async function withSpan<T>(name: string, fn: (span: Span) => Promise<T>): Promise<T> {
  const tracer = trace.getTracer(TRACER_NAME);
  return tracer.startActiveSpan(name, async (span) => {
    try {
      return await fn(span);
    } catch (error) {
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}
