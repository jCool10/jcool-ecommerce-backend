import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { ClsService } from 'nestjs-cls';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSpan } from '../tracing/tracer';
import { ACTOR_KEY, getCorrelationId, getLogActor, setLogActor } from './cls.setup';

// Only isActive()/getId() are exercised by getCorrelationId.
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

    // With tracing on there IS an active span, but requestId must NOT become the traceId —
    // that split (traceId lives in a separate field) is the whole point of the contract.
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

describe('log actor', () => {
  // Only isActive()/set()/get() are exercised; a map stands in for the CLS store.
  function storeCls(active: boolean): ClsService & { stored: Record<string, unknown> } {
    const stored: Record<string, unknown> = {};
    return {
      stored,
      isActive: () => active,
      set: (key: string, value: unknown) => {
        stored[key] = value;
      },
      get: (key: string) => stored[key],
    } as unknown as ClsService & { stored: Record<string, unknown> };
  }

  it('round-trips the actor through CLS', () => {
    const cls = storeCls(true);

    setLogActor(cls, { userId: 'user-8', role: 'ADMIN' });

    expect(getLogActor(cls)).toEqual({ userId: 'user-8', role: 'ADMIN' });
    expect(cls.stored[ACTOR_KEY]).toEqual({ userId: 'user-8', role: 'ADMIN' });
  });

  // Background work (schedulers, the outbox relay) has no actor; setting one there is a no-op
  // rather than a throw, because a logging concern must never fail its caller.
  it('is a no-op outside a request instead of throwing', () => {
    const cls = storeCls(false);

    expect(() => setLogActor(cls, { userId: 'user-8', role: 'ADMIN' })).not.toThrow();
    expect(cls.stored).toEqual({});
    expect(getLogActor(cls)).toBeUndefined();
  });

  // Absence, not an empty string — so `userId:*` is itself the "authenticated traffic" filter.
  it('returns undefined on an anonymous request', () => {
    expect(getLogActor(storeCls(true))).toBeUndefined();
  });
});
