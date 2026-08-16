import { context, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractTraceContext, injectTraceContext } from './propagation';
import { withSpan } from './tracer';

let provider: BasicTracerProvider;

beforeAll(() => {
  context.disable();
  trace.disable();
  propagation.disable();
  provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(new InMemorySpanExporter())] });
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  trace.setGlobalTracerProvider(provider);
});

afterAll(async () => {
  await provider.shutdown();
  context.disable();
  trace.disable();
  propagation.disable();
});

describe('trace propagation helpers', () => {
  it('injects a W3C traceparent carrying the active span traceId', async () => {
    await withSpan('produce', (span) => {
      const carrier = injectTraceContext({});
      expect(carrier.traceparent).toBeDefined();
      expect(carrier.traceparent).toContain(span.spanContext().traceId);
      return Promise.resolve();
    });
  });

  it('injects nothing when there is no active span', () => {
    const carrier = injectTraceContext({});
    expect(carrier.traceparent).toBeUndefined();
  });

  it('round-trips: extract rebuilds the parent context so the traceId survives the hop', async () => {
    let injected: Record<string, string> = {};
    let producerTraceId = '';

    await withSpan('produce', (span) => {
      producerTraceId = span.spanContext().traceId;
      injected = injectTraceContext({});
      return Promise.resolve();
    });

    const parent = extractTraceContext(injected);
    expect(trace.getSpan(parent)?.spanContext().traceId).toBe(producerTraceId);
  });
});
