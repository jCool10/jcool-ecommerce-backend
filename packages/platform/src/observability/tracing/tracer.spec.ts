import { SpanStatusCode } from '@opentelemetry/api';
import { describe, expect, it } from 'vitest';
import { useInMemoryTracer } from '../../testing/in-memory-tracer';
import { withSpan } from './tracer';

describe('withSpan', () => {
  const exporter = useInMemoryTracer();

  it('returns the callback result and ends one span with status unset', async () => {
    const result = await withSpan('unit.ok', () => Promise.resolve(42));

    expect(result).toBe(42);
    expect(exporter.getFinishedSpans().map((span) => [span.name, span.status.code])).toEqual([
      ['unit.ok', SpanStatusCode.UNSET],
    ]);
  });

  it('records the exception, marks the span ERROR, and rethrows the original error', async () => {
    const boom = new Error('boom');

    await expect(withSpan('unit.fail', () => Promise.reject(boom))).rejects.toBe(boom);

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].status.code).toBe(SpanStatusCode.ERROR);
    expect(spans[0].events.map((event) => event.name)).toContain('exception');
  });
});
