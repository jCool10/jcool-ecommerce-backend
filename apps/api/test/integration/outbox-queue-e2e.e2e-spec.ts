import type { INestApplication } from '@nestjs/common';
import { context, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { eq, isNull } from 'drizzle-orm';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import { OutboxRelay } from '../../src/shared/messaging/outbox/outbox-relay';
import { OUTBOX_WRITER, type OutboxWriterPort } from '../../src/shared/messaging/outbox/outbox-writer.port';
import { DomainEventProcessor } from '../../src/shared/messaging/queue/domain-event.processor';
import { DOMAIN_EVENTS_CONSUMER } from '../../src/shared/messaging/queue/queue.constants';
import { ConsumerRetryStore } from '../../src/shared/messaging/retry/consumer-retry.store';
import {
  DOMAIN_EVENT_PUBLISHER,
  type DomainEventPublisher,
} from '../../src/shared/messaging/transport/domain-event-publisher.port';
import { withSpan } from '@jcool/platform/observability';
import { authHeader } from '../setup/bearer.helper';
import { publishedEnvelopes, snapshotTransportBeforeEach } from '../setup/domain-event-transport';
import { buyerWithCart, seedSellableSku } from '../setup/fixtures/order-flow.fixture';
import { closeAppAfterAll, createTestAppWithPool, resetDatabaseBeforeEach } from '../setup/harness';
import { idempotencyKeyHeader } from '../setup/idempotency.helper';
import { E2E_METRICS_TOKEN, metricsAuthHeader } from '../setup/metrics.helper';
import { createTestApp } from '../setup/test-app.factory';
import { testId } from '../setup/id-service-stub';

const seedRow = (overrides: Record<string, unknown> = {}, orderId = testId()) => ({
  id: testId(),
  aggregateType: 'Order',
  aggregateId: orderId,
  eventType: 'order.placed',
  payload: { orderId, totalAmountMinor: 150_000 },
  ...overrides,
});

/**
 * The hops themselves have their own suites (outbox-append, outbox-relay, consumer-idempotency,
 * dead-letter). This one is about the telemetry that has to be true at each hop, and one trace id
 * from the producer through the broker to the effect.
 */
describe('Outbox to queue to consumer, end to end (integration, real Postgres + Redis)', () => {
  let app: INestApplication;
  let relay: OutboxRelay;
  let processor: DomainEventProcessor;
  let writer: OutboxWriterPort;
  let publisher: DomainEventPublisher;
  let db: DrizzleDB;
  let pool: Pool;

  const scrape = async (): Promise<string> => {
    const { text } = await request(app.getHttpServer()).get('/metrics').set(metricsAuthHeader()).expect(200);
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

  const seed = (count: number, overrides: Record<string, unknown> = {}) =>
    db
      .insert(schema.outbox)
      .values(Array.from({ length: count }, () => seedRow(overrides)))
      .returning();

  beforeAll(async () => {
    ({ app, pool, db } = await createTestAppWithPool({ METRICS_TOKEN: E2E_METRICS_TOKEN }));
    relay = app.get(OutboxRelay);
    processor = app.get(DomainEventProcessor);
    writer = app.get<OutboxWriterPort>(OUTBOX_WRITER);
    publisher = app.get<DomainEventPublisher>(DOMAIN_EVENT_PUBLISHER);
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);
  snapshotTransportBeforeEach(() => app);

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
      // rejection here would take the whole endpoint dark at the moment the database is unreachable.
      expect(text).toContain('http_requests_total');
      // The last reading stands rather than dropping to a zero that would read as "nothing pending".
      expect(gauge(text, 'outbox_backlog_pending')).toBe(1);
    });
  });

  describe('retry gauges', () => {
    const PENDING = `messaging_retry_pending{consumer="${DOMAIN_EVENTS_CONSUMER}"}`;
    const DEAD = `messaging_dead_letters{consumer="${DOMAIN_EVENTS_CONSUMER}"}`;

    const fileRetries = (status: 'pending' | 'dead', count: number) =>
      db.insert(schema.consumerRetries).values(
        Array.from({ length: count }, () => {
          const row = seedRow();
          return {
            consumer: DOMAIN_EVENTS_CONSUMER,
            messageId: row.id,
            eventType: row.eventType,
            envelope: { ...row, outboxId: row.id, occurredAt: new Date().toISOString(), traceparent: null },
            attemptsMade: 1,
            nextAttemptAt: new Date(Date.now() + 60_000),
            status,
            deadReason: status === 'dead' ? ('permanent' as const) : null,
            lastError: 'Error: handler refused',
          };
        }),
      );

    it('reports the retries waiting and the dead letters of each consumer', async () => {
      await fileRetries('pending', 2);
      await fileRetries('dead', 1);

      const text = await scrape();

      expect(gauge(text, PENDING)).toBe(2);
      expect(gauge(text, DEAD)).toBe(1);
    });

    it('keeps serving every other metric when the retry query fails', async () => {
      await fileRetries('pending', 1);
      await scrape();
      vi.spyOn(app.get(ConsumerRetryStore), 'countByStatus').mockRejectedValueOnce(
        new Error('connection terminated unexpectedly'),
      );

      const text = await scrape();

      expect(text).toContain('http_requests_total');
      expect(gauge(text, PENDING)).toBe(1);
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
      // than the broker being down, the same split the retry budget is charged on.
      const publish = publisher.publish.bind(publisher);
      vi.spyOn(publisher, 'publish').mockImplementationOnce(async ([refused, ...rest]) => [
        { rowId: refused.rowId, ok: false, error: new Error('broker rejected the message') },
        ...(await publish(rest)),
      ]);

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
    // Its own app: every other test here drives the processor by hand, which needs the worker off.
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
      const [event] = await db.select().from(schema.outbox).where(eq(schema.outbox.aggregateId, orderId));
      // A new group reads its topics from the start, so what earlier tests published is claimed too.
      const claimed = await vi.waitFor(
        async () => {
          const [row] = await db.select().from(schema.inbox).where(eq(schema.inbox.messageId, event.id));
          expect(row).toBeDefined();
          return row;
        },
        { timeout: 15_000, interval: 50 },
      );

      // One id from the write to the claim: the outbox row is the message the inbox dedups on.
      expect(claimed.eventType).toBe('order.placed');
      expect(event.publishedAt).not.toBeNull();
      expect(await unpublished()).toHaveLength(0);
      expect(gauge(await scrape(), 'outbox_backlog_pending')).toBe(0);
    } finally {
      await consumer.close();
    }
  });

  // Everything else runs with no tracing SDK, production's default. These register one so the spans
  // are real and the assertions cannot pass vacuously.
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
      // Stands in for the HTTP request span, which auto-instrumentation adds in production. Under
      // test is the hop it cannot make: an async one through the broker.
      await withSpan('order.place', async (span) => {
        producerTraceId = span.spanContext().traceId;
        const orderId = testId();
        await db.transaction((tx) =>
          writer.append(tx, {
            aggregateType: 'Order',
            aggregateId: orderId,
            eventType: 'order.placed',
            payload: { orderId, totalAmountMinor: 150_000 },
          }),
        );
      });

      // Outside the producer span on purpose: the relay is a separate tick, and in production a
      // separate process. It has nothing to continue the trace from but the stored header.
      const [stored] = await unpublished();
      expect(stored.traceparent).toContain(producerTraceId);

      await expect(relay.runOnce(10)).resolves.toEqual({ published: 1, failed: 0 });
      const [published] = await publishedEnvelopes(app);
      const delivered = published.envelope!;
      expect(delivered.traceparent).toContain(producerTraceId);

      // Driven through the processor rather than a consumer so the assertion lands on a finished
      // span: a consumer would take this on its own timeline. The envelope still came off the broker.
      await expect(processor.process(delivered, DOMAIN_EVENTS_CONSUMER)).resolves.toBe('processed');

      const spans = exporter.getFinishedSpans();
      const names = spans.map((span) => span.name);
      expect(names).toContain('order.place');
      expect(names).toContain('outbox.publish');
      expect(names).toContain('consume:order.placed');
      expect(new Set(spans.map((span) => span.spanContext().traceId))).toEqual(new Set([producerTraceId]));
    });

    it('starts a fresh trace for an event written with no trace to continue', async () => {
      await seed(1);

      await relay.runOnce(10);

      const [publish] = exporter.getFinishedSpans().filter((span) => span.name === 'outbox.publish');
      // An event written with no trace roots its own rather than dropping the span. The missing
      // parent is what makes it a root; a well-formed trace id would be true of any span.
      expect(publish.parentSpanContext).toBeUndefined();
      expect(publish.spanContext().traceId).toMatch(/^[0-9a-f]{32}$/);
    });
  });
});
