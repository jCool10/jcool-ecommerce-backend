import { context, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { JobsOptions, Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MetricsPort } from '@jcool/metrics-port';
import { fakeConfigService } from '@jcool/testing/fake-config.service';
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

function build(rows: OutboxRow[]) {
  const sets: Record<string, unknown>[] = [];
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
  const recordEventPublished = vi.fn();
  const error = vi.fn();
  const logger = fakePinoLogger({ error });

  const relay = new OutboxRelay(
    { transaction: (run: (t: unknown) => unknown) => run(tx) } as unknown as MessagingDb,
    new Map([
      ['orders', queue('orders')],
      ['catalog', queue('catalog')],
    ]),
    { status: 'ready' } as unknown as Redis,
    { recordEventPublished } as unknown as MetricsPort,
    { routes: ROUTES },
    fakeConfigService({ 'queue.orderPaidAttempts': 15 }),
    logger,
  );

  const traceparents = () => add.mock.calls.map(([, job]) => (job as DomainEventJob).traceparent);
  return { relay, add, queued, sets, recordEventPublished, error, traceparents };
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
  it('adds a payment.authorized job on the long ladder the config sizes', async () => {
    const t = build([row({ aggregateType: 'Payment', eventType: 'payment.authorized' }), row()]);

    await t.relay.runOnce(10);

    const [[, , authorized], [, , placed]] = t.add.mock.calls as [unknown, unknown, JobsOptions][];
    expect(authorized).toMatchObject({ attempts: 15, backoff: { type: 'order-paid' } });
    expect(placed.attempts).toBeUndefined();
  });

  it('adds each row to the queue its route names, with that queue job options', async () => {
    const t = build([
      row({ eventType: 'catalog.product.changed', aggregateType: 'Product' }),
      row({ eventType: 'order.paid' }),
      row(),
    ]);

    await t.relay.runOnce(10);

    expect(t.queued).toEqual([
      ['catalog', 'catalog.product.changed'],
      ['orders', 'order.paid'],
      ['orders', 'order.placed'],
    ]);
    const options = t.add.mock.calls.map(([, , opts]) => opts as JobsOptions);
    expect(options[0]).toMatchObject({ attempts: 15, backoff: { type: 'order-paid' } });
    expect(options[0]).not.toHaveProperty('priority');
    expect(options[2].attempts).toBeUndefined();
  });

  // Only a row written before a deploy dropped its route can get here; it would wait in no queue.
  it('refuses a row with no route without publishing it or holding up the rows behind it', async () => {
    const unrouted = Array.from({ length: 4 }, () => row({ eventType: 'order.shipped' }));
    const routed = row();
    const t = build([...unrouted, routed]);

    const summary = await t.relay.runOnce(10);

    expect(summary).toEqual({ published: 1, failed: 4 });
    expect(t.queued).toEqual([['orders', 'order.placed']]);
    expect(t.sets.filter((values) => 'attempts' in values)).toHaveLength(4);
    expect(t.recordEventPublished).toHaveBeenCalledWith('unregistered', 'refused');
    expect(t.error).toHaveBeenCalledTimes(1);
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
