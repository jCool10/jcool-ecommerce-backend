import { context, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { JobsOptions, Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DrizzleDB } from '@shared/infrastructure/database/drizzle.tokens';
import type { MetricsPort } from '@jcool/metrics-port';
import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { sampleId } from '@shared/testing/id-generator.double';
import { type DomainEventJob, jobIdFor } from '../queue/domain-event.job';
import { dispatcherWith } from '../testing/domain-event-dispatcher.double';
import { OutboxRelay } from './outbox-relay';
import type { outbox } from './schema/outbox.schema';

type OutboxRow = typeof outbox.$inferSelect;

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const PRODUCER_SPAN_ID = '00f067aa0ba902b7';

const ORDER_ID = sampleId(0, 7);
let nextId = 1;
function row(overrides: Partial<OutboxRow> = {}): OutboxRow {
  return {
    id: sampleId(nextId++),
    aggregateType: 'Order',
    aggregateId: ORDER_ID,
    eventType: 'order.placed',
    payload: { orderId: ORDER_ID },
    traceparent: null,
    attempts: 0,
    createdAt: new Date('2026-08-24T00:00:00.000Z'),
    publishedAt: null,
    ...overrides,
  };
}

function build(rows: OutboxRow[]) {
  const tx = {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({ limit: (n: number) => ({ for: () => Promise.resolve(rows.slice(0, n)) }) }),
        }),
      }),
    }),
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
  };
  const add = vi.fn().mockResolvedValue(undefined);

  const relay = new OutboxRelay(
    { transaction: (run: (t: unknown) => unknown) => run(tx) } as unknown as DrizzleDB,
    { add } as unknown as Queue,
    { status: 'ready' } as unknown as Redis,
    { recordEventPublished: vi.fn() } as unknown as MetricsPort,
    dispatcherWith(),
    fakeConfigService({ 'queue.orderPaidAttempts': 15 }),
    fakePinoLogger(),
  );

  const traceparents = () => add.mock.calls.map(([, job]) => (job as DomainEventJob).traceparent);
  return { relay, add, traceparents };
}

describe('OutboxRelay', () => {
  // Without the globals the SDK installs at boot, `withSpan` yields a non-recording span and the
  // trace assertions below pass vacuously.
  const contextManager = new AsyncLocalStorageContextManager();
  let provider: BasicTracerProvider;

  beforeAll(() => {
    provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(new InMemorySpanExporter())] });
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

  // The job id is what makes a republish of the same row a no-op instead of a second delivery.
  it('publishes each row under a job id derived from the row id', async () => {
    const rows = [row(), row()];
    const t = build(rows);

    await t.relay.runOnce(10);

    const published = t.add.mock.calls.map(([, job, opts]) => [
      (job as DomainEventJob).outboxId,
      (opts as JobsOptions).jobId,
    ]);
    expect(published).toEqual(rows.map((r) => [r.id, jobIdFor(r.id)]));
  });

  // Each refusal can cost a full command timeout while the batch's row locks stay held.
  it('gives up on the batch after three refusals', async () => {
    const t = build(Array.from({ length: 20 }, () => row()));
    t.add.mockRejectedValue(new Error('Command timed out'));

    await t.relay.runOnce(20);

    expect(t.add).toHaveBeenCalledTimes(3);
  });

  it('continues the producer trace under a fresh span, keeping its sampling flag', async () => {
    const sampled = `00-${TRACE_ID}-${PRODUCER_SPAN_ID}-01`;
    const unsampled = `00-${TRACE_ID}-${PRODUCER_SPAN_ID}-00`;
    const t = build([row({ traceparent: sampled }), row({ traceparent: unsampled })]);

    await t.relay.runOnce(10);

    const [fromSampled, fromUnsampled] = t.traceparents();
    expect(fromSampled).toMatch(new RegExp(`^00-${TRACE_ID}-(?!${PRODUCER_SPAN_ID})[0-9a-f]{16}-01$`));
    expect(fromUnsampled).toMatch(new RegExp(`^00-${TRACE_ID}-(?!${PRODUCER_SPAN_ID})[0-9a-f]{16}-00$`));
  });

  // Production and e2e both run with OTEL_ENABLED unset, so this is the common path.
  describe('with no tracing SDK', () => {
    beforeAll(() => {
      trace.disable();
    });

    afterAll(() => {
      trace.setGlobalTracerProvider(provider);
    });

    it('forwards the stored header as is and carries null when there is none', async () => {
      const stored = `00-${TRACE_ID}-${PRODUCER_SPAN_ID}-01`;
      const t = build([row({ traceparent: stored }), row()]);

      await t.relay.runOnce(10);

      expect(t.traceparents()).toEqual([stored, null]);
    });
  });
});
