import { context, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withConsumeSpan } from './consume-span';

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const PUBLISH_SPAN_ID = '00f067aa0ba902b7';
const TRACEPARENT = `00-${TRACE_ID}-${PUBLISH_SPAN_ID}-01`;

// Asserted against a real SDK: a no-op tracer would pass every one of these vacuously.
describe('withConsumeSpan', () => {
  const contextManager = new AsyncLocalStorageContextManager();
  const exporter = new InMemorySpanExporter();
  let provider: BasicTracerProvider;

  beforeAll(() => {
    provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    context.setGlobalContextManager(contextManager.enable());
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());
    trace.setGlobalTracerProvider(provider);
  });

  afterAll(async () => {
    await provider.shutdown();
    contextManager.disable();
    context.disable();
    trace.disable();
    propagation.disable();
  });

  it('continues the producer trace as a child of the publish span', async () => {
    exporter.reset();

    await expect(withConsumeSpan('order.placed', TRACEPARENT, () => Promise.resolve('done'))).resolves.toBe('done');

    const [span] = exporter.getFinishedSpans();
    expect(span.name).toBe('consume:order.placed');
    expect(span.spanContext().traceId).toBe(TRACE_ID);
    expect(span.parentSpanContext?.spanId).toBe(PUBLISH_SPAN_ID);
  });

  it('starts its own trace when the event carries no context', async () => {
    exporter.reset();

    await withConsumeSpan('order.placed', null, () => Promise.resolve());

    const [span] = exporter.getFinishedSpans();
    // An event written before tracing was switched on is still worth a span of its own.
    expect(span.spanContext().traceId).not.toBe(TRACE_ID);
    expect(span.parentSpanContext).toBeUndefined();
  });

  it('records a failed consume on the span and rethrows', async () => {
    exporter.reset();

    await expect(withConsumeSpan('order.placed', TRACEPARENT, () => Promise.reject(new Error('boom')))).rejects.toThrow(
      'boom',
    );

    const [span] = exporter.getFinishedSpans();
    expect(span.events.map((event) => event.name)).toContain('exception');
  });
});
