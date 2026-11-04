import { context, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { JobsOptions, Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { fakeMetricsPort } from '@jcool/testing/fake-metrics-port';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import type { MessagingDb } from '../messaging.database';
import { type DomainEventJob, jobIdFor } from '../queue/domain-event.job';
import { ROUTES, sampleId } from '../testing/messaging-fixtures';
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

function build(rows: OutboxRow[], { status = 'ready' }: { status?: string } = {}) {
  const sets: Record<string, unknown>[] = [];
  const limits: number[] = [];
  // The relay asks for routed rows first, then for the rest with what room is left.
  const isRouted = (r: OutboxRow) => Object.hasOwn(ROUTES, r.eventType);
  const tx = {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: (n: number) => ({
              for: () => {
                limits.push(n);
                const wanted = limits.length === 1;
                return Promise.resolve(rows.filter((r) => isRouted(r) === wanted).slice(0, n));
              },
            }),
          }),
        }),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        sets.push(values);
        return { where: () => Promise.resolve() };
      },
    }),
  };
  const add = vi.fn().mockResolvedValue(undefined);
  const queued: [string, string][] = [];
  const queue = (name: string) =>
    ({
      name,
      add: (...args: unknown[]) => {
        queued.push([name, (args[1] as DomainEventJob).eventType]);
        return add(...args) as Promise<unknown>;
      },
    }) as unknown as Queue;
  const transaction = vi.fn((run: (t: unknown) => unknown) => run(tx));
  const metrics = fakeMetricsPort();
  const error = vi.fn();
  const warn = vi.fn();
  const logger = fakePinoLogger({ error, warn });

  const relay = new OutboxRelay(
    { transaction } as unknown as MessagingDb,
    new Map([
      ['orders', queue('orders')],
      ['catalog', queue('catalog')],
    ]),
    { status } as unknown as Redis,
    metrics,
    { routes: ROUTES },
    fakeConfigService({ 'queue.orderPaidAttempts': 15 }),
    logger,
  );

  const traceparents = () => add.mock.calls.map(([, job]) => (job as DomainEventJob).traceparent);
  const charged = () => sets.filter((values) => 'attempts' in values);
  const marked = () => sets.filter((values) => 'publishedAt' in values);
  const refuse = (...ids: string[]) =>
    add.mockImplementation((_name: string, job: DomainEventJob) =>
      ids.includes(job.outboxId) ? Promise.reject(new Error('Command timed out')) : Promise.resolve(undefined),
    );
  return { relay, add, queued, sets, limits, metrics, error, warn, transaction, traceparents, charged, marked, refuse };
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

  // BullMQ takes attempts from the producer, so the relay is where the long ladder is set.
  it('adds each row to the queue its route names, with that queue job options', async () => {
    const t = build([
      row({ eventType: 'catalog.product.changed', aggregateType: 'Product' }),
      row({ eventType: 'order.paid' }),
      row({ eventType: 'payment.authorized', aggregateType: 'Payment' }),
      row(),
    ]);

    await t.relay.runOnce(10);

    expect(t.queued).toEqual([
      ['catalog', 'catalog.product.changed'],
      ['orders', 'order.paid'],
      ['orders', 'payment.authorized'],
      ['orders', 'order.placed'],
    ]);
    const options = t.add.mock.calls.map(([, , opts]) => opts as JobsOptions);
    expect(options[0]).toMatchObject({ attempts: 15, backoff: { type: 'order-paid' } });
    expect(options[2]).toMatchObject({ attempts: 15, backoff: { type: 'order-paid' } });
    expect(options[3].attempts).toBeUndefined();
  });

  // Only a row written before a deploy dropped its route can get here; it would wait in no queue.
  it('refuses a row with no route without publishing it or holding up the rows behind it', async () => {
    const unrouted = Array.from({ length: 4 }, () => row({ eventType: 'order.shipped' }));
    const routed = row();
    const t = build([...unrouted, routed]);

    const summary = await t.relay.runOnce(10);

    expect(summary).toEqual({ published: 1, failed: 4 });
    expect(t.queued).toEqual([['orders', 'order.placed']]);
    expect(t.charged()).toHaveLength(4);
    expect(t.metrics.recordEventPublished).toHaveBeenCalledWith('unregistered', 'refused');
    expect(t.error).toHaveBeenCalledTimes(1);
  });

  it('publishes routed rows even when a batch-size pile of unrouted rows is older', async () => {
    const unrouted = Array.from({ length: 3 }, () => row({ eventType: 'order.shipped' }));
    const t = build([...unrouted, row()]);

    const summary = await t.relay.runOnce(3);

    expect(summary).toEqual({ published: 1, failed: 2 });
    expect(t.queued).toEqual([['orders', 'order.placed']]);
    expect(t.limits).toEqual([3, 2]);
  });

  it('leaves unrouted rows unread while routed rows fill the batch', async () => {
    const t = build([row({ eventType: 'order.shipped' }), row(), row()]);

    const summary = await t.relay.runOnce(2);

    expect(summary).toEqual({ published: 2, failed: 0 });
    expect(t.limits).toEqual([2]);
  });

  // Each refusal can cost a full command timeout while the batch's row locks stay held.
  it('gives up on the batch after three refusals', async () => {
    const t = build(Array.from({ length: 20 }, () => row()));
    t.add.mockRejectedValue(new Error('Command timed out'));

    await t.relay.runOnce(20);

    expect(t.add).toHaveBeenCalledTimes(3);
  });

  // A queue refusing everything is an outage, not three bad rows; charging it would let one outage
  // dead-letter a healthy backlog.
  it('charges no attempt when every publish in the batch is refused', async () => {
    const rows = [row(), row()];
    const t = build(rows);
    t.refuse(...rows.map((r) => r.id));

    const summary = await t.relay.runOnce(10);

    expect(summary).toEqual({ published: 0, failed: 2 });
    expect(t.charged()).toEqual([]);
    expect(t.marked()).toEqual([]);
    expect(t.warn).toHaveBeenCalledWith(expect.objectContaining({ refused: 2, charged: false }), expect.any(String));
  });

  it('charges only the refused row once another row in the batch got through', async () => {
    const delivered = row();
    const rejected = row({ attempts: 4 });
    const t = build([delivered, rejected]);
    t.refuse(rejected.id);

    const summary = await t.relay.runOnce(10);

    expect(summary).toEqual({ published: 1, failed: 1 });
    expect(t.charged()).toEqual([{ attempts: 5 }]);
    expect(t.marked()).toEqual([{ publishedAt: expect.any(Date) as unknown }]);
    expect(t.warn).toHaveBeenCalledWith(
      expect.objectContaining({ refused: 1, charged: true, outboxId: rejected.id }),
      expect.any(String),
    );
  });

  it('marks every published row published', async () => {
    const t = build([row(), row(), row()]);

    await t.relay.runOnce(10);

    expect(t.marked()).toHaveLength(3);
    expect(t.charged()).toEqual([]);
  });

  it('opens no transaction and publishes nothing while the queue connection is not ready', async () => {
    const t = build([row()], { status: 'reconnecting' });

    const summary = await t.relay.runOnce(10);

    expect(summary).toEqual({ published: 0, failed: 0 });
    expect(t.transaction).not.toHaveBeenCalled();
    expect(t.add).not.toHaveBeenCalled();
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
