import { ROOT_CONTEXT, TraceFlags, context, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DrizzleTx } from '@shared/infrastructure/database/drizzle.tokens';
import { DrizzleOutboxWriter } from './drizzle-outbox.writer';
import type { OutboxRecord } from './outbox-writer.port';

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const SPAN_ID = '00f067aa0ba902b7';

const RECORD: OutboxRecord = {
  aggregateType: 'Order',
  aggregateId: '01a03000-0000-7000-8000-000000000001',
  eventType: 'order.placed',
  payload: { orderId: '01a03000-0000-7000-8000-000000000001' },
};

function fakeTx() {
  const values = vi.fn().mockResolvedValue(undefined);
  const insert = vi.fn().mockReturnValue({ values });
  return { tx: { insert } as unknown as DrizzleTx, values };
}

const inSpan = <T>(fn: () => T): T =>
  context.with(
    trace.setSpanContext(ROOT_CONTEXT, { traceId: TRACE_ID, spanId: SPAN_ID, traceFlags: TraceFlags.SAMPLED }),
    fn,
  );

// Covered here rather than in e2e because tracing is off there — with no SDK, there is no span to
// capture, and the producer's context must be serialized into the row at insert time.
describe('DrizzleOutboxWriter', () => {
  // Both globals are what the SDK installs at boot. Without the context manager `context.with` is a
  // no-op and `context.active()` always returns ROOT_CONTEXT, so the span would never be seen.
  const contextManager = new AsyncLocalStorageContextManager();

  beforeAll(() => {
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());
    context.setGlobalContextManager(contextManager.enable());
  });

  afterAll(() => {
    contextManager.disable();
    context.disable();
    propagation.disable();
  });

  it('stamps the active span as a W3C traceparent', async () => {
    const { tx, values } = fakeTx();

    await inSpan(() => new DrizzleOutboxWriter().append(tx, RECORD));

    expect(values).toHaveBeenCalledWith(expect.objectContaining({ traceparent: `00-${TRACE_ID}-${SPAN_ID}-01` }));
  });

  it('writes null rather than a malformed header when no span is active', async () => {
    const { tx, values } = fakeTx();

    await new DrizzleOutboxWriter().append(tx, RECORD);

    expect(values).toHaveBeenCalledWith(expect.objectContaining({ traceparent: null }));
  });

  it('forwards the record unchanged and never opens a transaction of its own', async () => {
    const { tx, values } = fakeTx();

    await new DrizzleOutboxWriter().append(tx, RECORD);

    expect(values).toHaveBeenCalledWith(expect.objectContaining(RECORD));
    // No `transaction` member is ever touched: the fake would throw if the writer reached for one.
    expect(Object.keys(tx as object)).toEqual(['insert']);
  });
});
