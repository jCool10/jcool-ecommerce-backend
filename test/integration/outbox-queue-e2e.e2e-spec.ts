import type { INestApplication } from '@nestjs/common';
import { context, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { Queue } from 'bullmq';
import { eq, isNull } from 'drizzle-orm';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DRIZZLE, PG_POOL, type DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import { OutboxRelay } from '../../src/shared/messaging/outbox/outbox-relay';
import { OUTBOX_WRITER, type OutboxWriterPort } from '../../src/shared/messaging/outbox/outbox-writer.port';
import type { DomainEventJob } from '../../src/shared/messaging/queue/domain-event.job';
import { DomainEventProcessor } from '../../src/shared/messaging/queue/domain-event.processor';
import { DOMAIN_EVENTS_QUEUE } from '../../src/shared/messaging/queue/queue.constants';
import { withSpan } from '../../src/shared/observability/tracing/tracer';
import { authHeader } from '../setup/auth.helper';
import { buyerWithCart, seedSellableSku } from '../setup/fixtures/order-flow.fixture';
import { idempotencyKeyHeader } from '../setup/idempotency.helper';
import { resetDatabase } from '../setup/reset-database';
import { createTestApp } from '../setup/test-app.factory';

const METRICS_TOKEN = 'e2e-outbox-queue-metrics-token';

const seedRow = (index: number, overrides: Record<string, unknown> = {}) => ({
  aggregateType: 'Order',
  aggregateId: `0198f0d8-4444-7000-8000-${String(index).padStart(12, '0')}`,
  eventType: 'order.placed',
  payload: { orderId: `0198f0d8-4444-7000-8000-${String(index).padStart(12, '0')}`, totalAmountMinor: 150_000 },
  ...overrides,
});

/**
 * The hops themselves have their own suites (outbox-append, outbox-relay, consumer-idempotency,
 * dead-letter). This one is about the telemetry that has to be true at each hop: a backlog gauge
 * that reads the table rather than a constant, a publish counter that moves before the backlog
 * does, and one trace id from the producer through Redis to the effect.
 */
describe('Outbox → queue → consumer, end to end (integration, real Postgres + Redis)', () => {
  let app: INestApplication;
  let relay: OutboxRelay;
  let processor: DomainEventProcessor;
  let writer: OutboxWriterPort;
  let queue: Queue;
  let db: DrizzleDB;
  let pool: Pool;

  const scrape = async (): Promise<string> => {
    const { text } = await request(app.getHttpServer())
      .get('/metrics')
      .set('Authorization', `Bearer ${METRICS_TOKEN}`)
      .expect(200);
    return text;
  };

  // The prom-client registry is per file, but counters still accumulate across the tests inside it,
  // and a series an earlier test created would make a presence check pass with the counter call
  // deleted. Gauges are absolute (this suite owns the outbox table); counters are asserted as deltas.
  const gauge = (text: string, name: string): number => {
    const line = text.split('\n').find((entry) => entry.startsWith(`${name} `));
    if (line === undefined) throw new Error(`gauge ${name} is not exposed on /metrics`);
    return Number(line.slice(name.length + 1));
  };

  const counter = (text: string, series: string): number => {
    const line = text.split('\n').find((entry) => entry.startsWith(`${series} `));
    return line === undefined ? 0 : Number(line.slice(series.length + 1));
  };

  const unpublished = () => db.select().from(schema.outbox).where(isNull(schema.outbox.publishedAt));
  const inboxRows = () => db.select().from(schema.inbox);

  const seed = (count: number, overrides: Record<string, unknown> = {}) =>
    db
      .insert(schema.outbox)
      .values(Array.from({ length: count }, (_, i) => seedRow(i + 1, overrides)))
      .returning();

  beforeAll(async () => {
    app = await createTestApp({ METRICS_TOKEN });
    relay = app.get(OutboxRelay);
    processor = app.get(DomainEventProcessor);
    writer = app.get<OutboxWriterPort>(OUTBOX_WRITER);
    queue = app.get<Queue>(DOMAIN_EVENTS_QUEUE);
    db = app.get<DrizzleDB>(DRIZZLE);
    pool = app.get<Pool>(PG_POOL);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
    await queue.obliterate({ force: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('backlog gauges', () => {
    it('reports the rows actually waiting, and how long the oldest has waited', async () => {
      await seed(3);

      const text = await scrape();

      expect(gauge(text, 'outbox_backlog_pending')).toBe(3);
      // Aged against the database clock, so this is a real elapsed time and not a constant.
      expect(gauge(text, 'outbox_oldest_age_seconds')).toBeGreaterThan(0);
    });

    it('falls back to zero the moment the relay drains the table', async () => {
      await seed(2);
      await expect(relay.runOnce(10)).resolves.toEqual({ published: 2, failed: 0 });

      const text = await scrape();

      // The pair is the alert: a pending count that stays flat while the age climbs is a relay that
      // stopped, which is invisible if only one of the two is watched.
      expect(gauge(text, 'outbox_backlog_pending')).toBe(0);
      expect(gauge(text, 'outbox_oldest_age_seconds')).toBe(0);
    });

    it('counts only what is still unpublished, not every event ever emitted', async () => {
      await seed(2);
      await relay.runOnce(10);
      await seed(1);

      expect(gauge(await scrape(), 'outbox_backlog_pending')).toBe(1);
    });

    it('keeps serving every other metric when the backlog query fails', async () => {
      await seed(1);
      await scrape();
      vi.spyOn(db, 'select').mockImplementationOnce(() => {
        throw new Error('connection terminated unexpectedly');
      });

      const text = await scrape();

      // The decisive assertion is the 200 inside scrape(): a scrape awaits every collect(), so a
      // rejection here would take the WHOLE endpoint down — every unrelated series would go dark at
      // exactly the moment the database is unreachable.
      expect(text).toContain('http_requests_total');
      // The last reading stands rather than dropping to a zero that would read as "nothing pending".
      expect(gauge(text, 'outbox_backlog_pending')).toBe(1);
    });
  });

  describe('publish counter', () => {
    const PUBLISHED = 'messaging_publish_total{event_type="order.placed",result="published"}';
    const REFUSED = 'messaging_publish_total{event_type="order.placed",result="refused"}';
    const UNREGISTERED = 'messaging_publish_total{event_type="unregistered",result="published"}';

    it('counts a row the moment the queue accepts it', async () => {
      await seed(1);
      const before = counter(await scrape(), PUBLISHED);

      await relay.runOnce(10);

      expect(counter(await scrape(), PUBLISHED)).toBe(before + 1);
    });

    it('counts a refusal, which moves a tick before the backlog gauge does', async () => {
      await seed(2);
      const text = await scrape();
      const [beforeRefused, beforePublished] = [counter(text, REFUSED), counter(text, PUBLISHED)];
      // A healthy sibling in the batch, so the relay reads this as the row being rejected rather
      // than the queue being down — the same split the retry budget is charged on.
      vi.spyOn(queue, 'add').mockRejectedValueOnce(new Error('queue rejected the payload'));

      await expect(relay.runOnce(10)).resolves.toEqual({ published: 1, failed: 1 });

      const after = await scrape();
      expect(counter(after, REFUSED)).toBe(beforeRefused + 1);
      expect(counter(after, PUBLISHED)).toBe(beforePublished + 1);
    });

    it('folds an event type no consumer is registered for into one series', async () => {
      await seed(1, { eventType: 'payment.refunded' });
      const before = counter(await scrape(), UNREGISTERED);

      await relay.runOnce(10);

      const text = await scrape();
      // Cardinality iron rule: `outbox.event_type` is free text a producer wrote, so only the
      // dispatch table bounds it. The raw name must not appear as a label anywhere.
      expect(counter(text, UNREGISTERED)).toBe(before + 1);
      expect(text).not.toContain('event_type="payment.refunded"');
    });
  });

  it('carries a checkout from HTTP to a consumed effect, and the gauges follow it', async () => {
    const consumer = await createTestApp({ QUEUE_WORKER_ENABLED: 'true' });
    try {
      const sku = await seedSellableSku(app, { onHand: 5, priceMinor: 150_000 });
      const token = await buyerWithCart(app, sku.variantId, 2);
      const response = await request(app.getHttpServer())
        .post('/orders')
        .set(authHeader(token))
        .set(idempotencyKeyHeader())
        .expect(201);
      const orderId = response.body.id as string;

      // Committed with the order, and visible as a backlog before anything has carried it anywhere.
      expect(gauge(await scrape(), 'outbox_backlog_pending')).toBe(1);

      await expect(relay.runOnce(10)).resolves.toEqual({ published: 1, failed: 0 });
      await vi.waitFor(async () => expect(await inboxRows()).toHaveLength(1), { timeout: 15_000, interval: 50 });

      const [claimed] = await inboxRows();
      const [event] = await db.select().from(schema.outbox).where(eq(schema.outbox.aggregateId, orderId));
      // One id from the write to the claim: the outbox row is the message, and the inbox dedups on
      // it — which is what makes the whole at-least-once transport safe.
      expect(claimed.messageId).toBe(event.id);
      expect(claimed.eventType).toBe('order.placed');
      expect(event.publishedAt).not.toBeNull();
      expect(await unpublished()).toHaveLength(0);
      expect(gauge(await scrape(), 'outbox_backlog_pending')).toBe(0);
    } finally {
      await consumer.close();
    }
  });

  // Everything else runs with no tracing SDK — production's own default. These register one so the
  // spans are real and the assertions cannot pass vacuously.
  describe('trace continuity', () => {
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

    beforeEach(() => {
      exporter.reset();
    });

    it('runs one trace from the producing transaction through Redis to the effect', async () => {
      let producerTraceId = '';
      // Stands in for the HTTP request: in production the http.server span comes from
      // auto-instrumentation, which is preloaded via `node --import` and therefore absent here. What
      // is under test is the hop auto-instrumentation cannot make — an async one through Redis.
      await withSpan('order.place', async (span) => {
        producerTraceId = span.spanContext().traceId;
        await db.transaction((tx) =>
          writer.append(tx, {
            aggregateType: 'Order',
            aggregateId: '0198f0d8-4444-7000-8000-000000000009',
            eventType: 'order.placed',
            payload: { orderId: '0198f0d8-4444-7000-8000-000000000009', totalAmountMinor: 150_000 },
          }),
        );
      });

      // Outside the producer span on purpose: the relay is a separate tick, and in production a
      // separate process. It has nothing to continue the trace from but the stored header.
      const [stored] = await unpublished();
      expect(stored.traceparent).toContain(producerTraceId);

      await expect(relay.runOnce(10)).resolves.toEqual({ published: 1, failed: 0 });
      const [job] = await queue.getJobs(['waiting']);
      const delivered = job.data as DomainEventJob;
      expect(delivered.traceparent).toContain(producerTraceId);

      // Driven through the processor rather than a Worker so the assertion lands on a finished
      // span: a Worker would consume this on its own timeline. The queue hop is still real — this
      // envelope came back out of Redis.
      await expect(processor.process(delivered)).resolves.toBe('processed');

      const spans = exporter.getFinishedSpans();
      const names = spans.map((span) => span.name);
      expect(names).toContain('order.place');
      expect(names).toContain('outbox.publish');
      expect(names).toContain('consume:order.placed');
      // The whole point: one trace id. Three ids means three disconnected traces in Jaeger and no
      // way to answer "what did this request cause".
      expect(new Set(spans.map((span) => span.spanContext().traceId))).toEqual(new Set([producerTraceId]));
    });

    it('starts a fresh trace for an event written with no trace to continue', async () => {
      await seed(1);

      await relay.runOnce(10);

      const [publish] = exporter.getFinishedSpans().filter((span) => span.name === 'outbox.publish');
      // An event written before tracing was on, or by a background job, is not an error — it simply
      // roots its own trace instead of dropping the span. No parent is what makes it a root; a
      // well-formed trace id would be true of any span at all.
      expect(publish.parentSpanContext).toBeUndefined();
      expect(publish.spanContext().traceId).toMatch(/^[0-9a-f]{32}$/);
    });
  });
});
