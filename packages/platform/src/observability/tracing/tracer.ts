import { type Span, SpanStatusCode, trace } from '@opentelemetry/api';

const TRACER_NAME = 'jcool';

/**
 * Runs `fn` inside an active span. For business spans the auto-instrumentation cannot name
 * (`order.place`) — http/pg/ioredis are already covered. Yields a no-op span when OTel is off.
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
