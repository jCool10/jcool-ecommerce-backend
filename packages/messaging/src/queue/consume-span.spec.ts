import { context, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withConsumeSpan } from './consume-span';

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const PUBLISH_SPAN_ID = '00f067aa0ba902b7';
const TRACEPARENT = `00-${TRACE_ID}-${PUBLISH_SPAN_ID}-01`;

// Asserted against a real SDK: a no-op tracer would pass vacuously.
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
    await expect(withConsumeSpan('order.placed', TRACEPARENT, () => Promise.resolve('done'))).resolves.toBe('done');

    const [span] = exporter.getFinishedSpans();
    expect(span.name).toBe('consume:order.placed');
    expect(span.spanContext().traceId).toBe(TRACE_ID);
    expect(span.parentSpanContext?.spanId).toBe(PUBLISH_SPAN_ID);
  });
});
