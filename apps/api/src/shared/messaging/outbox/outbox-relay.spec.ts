import { context, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { JobsOptions, Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DrizzleDB } from '@shared/infrastructure/database/drizzle.tokens';
import type { MetricsPort } from '@jcool/metrics-port';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { sampleId } from '@shared/testing/id-generator.double';
import { BullmqDomainEventPublisher } from '../queue/bullmq-domain-event.publisher';
import type { DomainEventJob } from '../queue/domain-event.job';
import { CATALOG_EVENT_PRIORITY } from '../queue/queue.constants';
import { dispatcherWith } from '../testing/domain-event-dispatcher.double';
import type { DomainEventPublisher, OutboundEvent, PublishOutcome } from '../transport/domain-event-publisher.port';
import { OutboxRelay } from './outbox-relay';
import type { outbox } from './schema/outbox.schema';

type OutboxRow = typeof outbox.$inferSelect;

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const PRODUCER_SPAN_ID = '00f067aa0ba902b7';

const ORDER_ID = sampleId(0);
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

type Answer = (events: OutboundEvent[]) => PublishOutcome[];

const acceptAll: Answer = (events) => events.map(({ rowId }) => ({ rowId, ok: true }));

/** Drives the relay through the BullMQ adapter over a fake queue unless a test hands it a port of its own. */
function build(rows: OutboxRow[], port?: DomainEventPublisher) {
  const updates: Array<Record<string, unknown>> = [];
  const tx = {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({ limit: (n: number) => ({ for: () => Promise.resolve(rows.slice(0, n)) }) }),
        }),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        updates.push(values);
        return { where: () => Promise.resolve() };
      },
    }),
  };
  const transaction = vi.fn((run: (t: unknown) => unknown) => run(tx));
  const add = vi.fn().mockResolvedValue(undefined);
  const publisher =
    port ?? new BullmqDomainEventPublisher({ add } as unknown as Queue, { status: 'ready' } as unknown as Redis);
  const publish = vi.spyOn(publisher, 'publish');
  const recordEventPublished = vi.fn<MetricsPort['recordEventPublished']>();

  const relay = new OutboxRelay(
    { transaction } as unknown as DrizzleDB,
    publisher,
    { recordEventPublished } as unknown as MetricsPort,
    dispatcherWith(),
    fakePinoLogger(),
  );

  const envelopes = (): DomainEventJob[] => publish.mock.calls.flatMap(([events]) => events.map((e) => e.envelope));
  const traceparents = () => envelopes().map((envelope) => envelope.traceparent);
  const marked = () => updates.filter((values) => 'publishedAt' in values).length;
  const charged = () => updates.filter((values) => 'attempts' in values).map((values) => values.attempts);
  return { relay, add, publish, transaction, envelopes, traceparents, marked, charged, recordEventPublished };
}

function stubPublisher(answer: Answer = acceptAll): DomainEventPublisher {
  return { ready: () => true, publish: (events) => Promise.resolve(answer(events)) };
}

describe('OutboxRelay', () => {
  // Without the globals the SDK installs at boot, the publish spans are non-recording and the trace
  // assertions below pass vacuously.
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

  // A job id would let BullMQ swallow a republish while it still remembers the row's earlier job.
  it('publishes every row as a fresh job and leaves dedup to the inbox', async () => {
    const rows = [row(), row()];
    const t = build(rows);

    await t.relay.runOnce(10);

    expect(t.add.mock.calls.map(([, job]) => (job as DomainEventJob).outboxId)).toEqual(rows.map((r) => r.id));
    expect(t.add.mock.calls.map(([, , opts]) => (opts as JobsOptions | undefined)?.jobId)).toEqual([
      undefined,
      undefined,
    ]);
  });

  // Attempts and backoff come from the queue defaults: they only matter when Postgres is down.
  it('queues only catalog events behind order and payment work', async () => {
    const t = build([row({ eventType: 'catalog.product.changed' }), row({ eventType: 'order.paid' })]);

    await t.relay.runOnce(10);

    expect(t.add.mock.calls.map(([, , opts]) => opts as JobsOptions | undefined)).toEqual([
      { priority: CATALOG_EVENT_PRIORITY },
      undefined,
    ]);
  });

  it('skips the tick without opening a transaction while the publisher is not ready', async () => {
    const t = build([row()], { ...stubPublisher(), ready: () => false });

    await expect(t.relay.runOnce(10)).resolves.toEqual({ published: 0, failed: 0 });

    expect(t.transaction).not.toHaveBeenCalled();
  });

  it('hands the whole batch to the publisher in one call, each row as its own envelope', async () => {
    const rows = [row({ traceparent: null }), row({ aggregateId: sampleId(99), eventType: 'payment.succeeded' })];
    const t = build(rows, stubPublisher());

    await t.relay.runOnce(10);

    expect(t.publish).toHaveBeenCalledTimes(1);
    expect(t.publish.mock.calls[0][0]).toEqual(
      rows.map((r) => ({
        rowId: r.id,
        eventType: r.eventType,
        aggregateId: r.aggregateId,
        envelope: {
          outboxId: r.id,
          aggregateType: r.aggregateType,
          aggregateId: r.aggregateId,
          eventType: r.eventType,
          payload: r.payload,
          occurredAt: r.createdAt.toISOString(),
          traceparent: expect.any(String) as unknown,
        },
      })),
    );
  });

  it('marks only the rows the publisher acknowledged as published', async () => {
    const rows = [row(), row(), row()];
    const t = build(
      rows,
      stubPublisher((events) => events.map(({ rowId }, i) => ({ rowId, ok: i !== 1, error: new Error('no') }))),
    );

    await expect(t.relay.runOnce(10)).resolves.toEqual({ published: 2, failed: 1 });

    expect(t.marked()).toBe(2);
  });

  // An acknowledged neighbour is the proof the broker works and this row is what it rejected.
  it('charges an attempt to a refused row only when another row in the batch got through', async () => {
    const refusedAlongsideAck = build(
      [row({ attempts: 2 }), row()],
      stubPublisher((events) => events.map(({ rowId }, i) => ({ rowId, ok: i === 1 }))),
    );
    await refusedAlongsideAck.relay.runOnce(10);
    expect(refusedAlongsideAck.charged()).toEqual([3]);

    const allRefused = build(
      [row(), row()],
      stubPublisher((events) => events.map(({ rowId }) => ({ rowId, ok: false, error: new Error('down') }))),
    );
    await expect(allRefused.relay.runOnce(10)).resolves.toEqual({ published: 0, failed: 2 });
    expect(allRefused.charged()).toEqual([]);
    expect(allRefused.marked()).toBe(0);
  });

  // Behind the third refusal nothing is sent, so those rows must look as if the tick never saw them.
  it('leaves the rows the BullMQ adapter never sent exactly as they were', async () => {
    const t = build([row(), row(), row(), row(), row(), row()]);
    t.add.mockResolvedValueOnce(undefined).mockRejectedValue(new Error('Command timed out'));

    await expect(t.relay.runOnce(10)).resolves.toEqual({ published: 1, failed: 3 });

    expect(t.add).toHaveBeenCalledTimes(4);
    expect(t.charged()).toEqual([1, 1, 1]);
    expect(t.recordEventPublished.mock.calls.map(([, result]) => result)).toEqual([
      'published',
      'refused',
      'refused',
      'refused',
    ]);
  });

  it('does not call the publisher for an empty backlog', async () => {
    const t = build([], stubPublisher());

    await expect(t.relay.runOnce(10)).resolves.toEqual({ published: 0, failed: 0 });

    expect(t.publish).not.toHaveBeenCalled();
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
