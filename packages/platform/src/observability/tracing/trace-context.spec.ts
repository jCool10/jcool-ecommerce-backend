import { INVALID_SPAN_CONTEXT, context, trace } from '@opentelemetry/api';
import { describe, expect, it } from 'vitest';
import { useInMemoryTracer } from '../../testing/in-memory-tracer';
import { getActiveTraceId } from './trace-context';
import { withSpan } from './tracer';

describe('getActiveTraceId', () => {
  useInMemoryTracer();

  it('gives the active span traceId, and nothing without a valid span', async () => {
    const invalid = trace.setSpan(context.active(), trace.wrapSpanContext(INVALID_SPAN_CONTEXT));
    const [seen, expected] = await withSpan('active', (span) =>
      Promise.resolve([getActiveTraceId(), span.spanContext().traceId]),
    );

    expect(seen).toBe(expected);
    expect([getActiveTraceId(), context.with(invalid, getActiveTraceId)]).toEqual([undefined, undefined]);
  });
});
