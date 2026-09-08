import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { ClsService } from 'nestjs-cls';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSpan } from '../tracing/tracer';
import { getCorrelationId } from './cls.setup';

function fakeCls(opts: { active: boolean; id?: string }): ClsService {
  return { isActive: () => opts.active, getId: () => opts.id } as unknown as ClsService;
}

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

describe('getCorrelationId', () => {
  it('returns the CLS request id even when a span is active (requestId stays the client id)', async () => {
    const cls = fakeCls({ active: true, id: 'req-uuid' });

    // A span is active here, and requestId must still NOT become the traceId.
    await withSpan('active', (span) => {
      expect(span.spanContext().traceId).toHaveLength(32);
      expect(getCorrelationId(cls)).toBe('req-uuid');
      return Promise.resolve();
    });
  });

  it('returns the CLS request id when no span is active', () => {
    const cls = fakeCls({ active: true, id: 'req-uuid' });
    expect(getCorrelationId(cls)).toBe('req-uuid');
  });

  it('returns undefined outside a request (CLS inactive)', () => {
    const cls = fakeCls({ active: false });
    expect(getCorrelationId(cls)).toBeUndefined();
  });
});
