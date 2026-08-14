import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSpan } from './tracer';
import { getActiveTraceId } from './trace-context';

let provider: BasicTracerProvider;

beforeAll(() => {
  context.disable();
  trace.disable();
  provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(new InMemorySpanExporter())] });
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  trace.setGlobalTracerProvider(provider);
});

afterAll(async () => {
  await provider.shutdown();
  context.disable();
  trace.disable();
});

describe('getActiveTraceId', () => {
  it('returns the active span traceId (the log↔trace join key)', async () => {
    await withSpan('active', (span) => {
      expect(getActiveTraceId()).toBe(span.spanContext().traceId);
      return Promise.resolve();
    });
  });

  it('returns undefined when no span is active (tracing off)', () => {
    expect(getActiveTraceId()).toBeUndefined();
  });
});
