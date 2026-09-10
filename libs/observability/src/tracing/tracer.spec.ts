import { SpanStatusCode, context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withSpan } from './tracer';

// A real in-memory tracer, since unit runs have no OTel SDK otherwise (OTEL_ENABLED unset) —
// which is exactly why withSpan must also work no-op.
const exporter = new InMemorySpanExporter();
let provider: BasicTracerProvider;

beforeAll(() => {
  context.disable();
  trace.disable();
  provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  trace.setGlobalTracerProvider(provider);
});

afterAll(async () => {
  await provider.shutdown();
  context.disable();
  trace.disable();
});

beforeEach(() => exporter.reset());

describe('withSpan', () => {
  it('returns the callback result and ends exactly one span (status UNSET on success)', async () => {
    const result = await withSpan('unit.ok', () => Promise.resolve(42));

    expect(result).toBe(42);
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe('unit.ok');
    expect(spans[0].status.code).toBe(SpanStatusCode.UNSET);
  });

  it('records the exception, marks the span ERROR, and rethrows the original error', async () => {
    const boom = new Error('boom');

    await expect(withSpan('unit.fail', () => Promise.reject(boom))).rejects.toBe(boom);

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].status.code).toBe(SpanStatusCode.ERROR);
    expect(spans[0].events.map((event) => event.name)).toContain('exception');
  });

  it('makes its span the active span so nested work nests under it', async () => {
    await withSpan('unit.parent', (parent) => {
      expect(trace.getActiveSpan()?.spanContext().traceId).toBe(parent.spanContext().traceId);
      return Promise.resolve();
    });
  });
});
