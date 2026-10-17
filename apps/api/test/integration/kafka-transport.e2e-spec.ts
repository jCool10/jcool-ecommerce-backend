import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Job, Queue } from 'bullmq';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Pool } from 'pg';
import request from 'supertest';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ProductChangedHandler } from '../../src/modules/product/interface/catalog/queue/product-changed.handler';
import type { DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import { DomainEventDispatcher } from '../../src/shared/messaging/handlers/domain-event.dispatcher';
import { KafkaConsumerGroups } from '../../src/shared/messaging/kafka/kafka-consumer-groups';
import { SIGNATURE_HEADER, signValue } from '../../src/shared/messaging/kafka/kafka-message-signature';
import { OutboxRelay } from '../../src/shared/messaging/outbox/outbox-relay';
import type { DomainEventJob } from '../../src/shared/messaging/queue/domain-event.job';
import { DOMAIN_EVENTS_QUEUE } from '../../src/shared/messaging/queue/queue.constants';
import { ConsumerRetryStore } from '../../src/shared/messaging/retry/consumer-retry.store';
import {
  DOMAIN_EVENT_PUBLISHER,
  type DomainEventPublisher,
} from '../../src/shared/messaging/transport/domain-event-publisher.port';
import { spyOnEffect } from '../setup/dispatcher-effect.helper';
import {
  consumerLag,
  deliverPublished,
  produceRaw,
  publishedEnvelopes,
  snapshotTransportBeforeEach,
} from '../setup/domain-event-transport';
import {
  closeAppAfterAll,
  createTestAppWithPool,
  obliterateQueueBeforeEach,
  resetDatabaseBeforeEach,
} from '../setup/harness';
import { testId } from '../setup/id-service-stub';
import { startKafka } from '../setup/kafka-container';
import { clearMetricsRegistry, E2E_METRICS_TOKEN, metricsAuthHeader } from '../setup/metrics.helper';
import { sleep } from '../setup/sleep';
import { reprovisionSpecTopics } from '../setup/spec-topics';

const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
const WAIT = { timeout: 15_000, interval: 50 };
const UNVERIFIED = 'messaging_dlq_total{event_type="unverified",reason="permanent"}';

type OutboxRow = typeof schema.outbox.$inferSelect;

const outboxRow = (overrides: Partial<typeof schema.outbox.$inferInsert> = {}) => {
  const orderId = testId();
  return {
    id: testId(),
    aggregateType: 'Order',
    aggregateId: orderId,
    eventType: 'order.placed',
    payload: { orderId, totalAmountMinor: 150_000 },
    ...overrides,
  };
};

const envelopeOf = (row: OutboxRow): DomainEventJob => ({
  outboxId: row.id,
  aggregateType: row.aggregateType,
  aggregateId: row.aggregateId,
  eventType: row.eventType,
  payload: row.payload,
  occurredAt: row.createdAt.toISOString(),
  traceparent: null,
});

const scrape = async (app: INestApplication): Promise<string> =>
  (await request(app.getHttpServer()).get('/metrics').set(metricsAuthHeader()).expect(200)).text;

const sample = (text: string, series: string): number => {
  const line = text.split('\n').find((entry) => entry.startsWith(`${series} `));
  return line === undefined ? 0 : Number(line.slice(series.length + 1));
};

const untilJoined = (app: INestApplication) =>
  vi.waitFor(() => expect(app.get(KafkaConsumerGroups).runners.every((runner) => runner.hasJoined())).toBe(true), {
    timeout: 30_000,
    interval: 100,
  });

describe('Kafka transport (integration, real Postgres + Kafka)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;
  let relay: OutboxRelay;

  const seed = (count: number, overrides: Partial<typeof schema.outbox.$inferInsert> = {}) =>
    db
      .insert(schema.outbox)
      .values(Array.from({ length: count }, () => outboxRow(overrides)))
      .returning();

  const rowsById = (ids: string[]) => db.select().from(schema.outbox).where(inArray(schema.outbox.id, ids));
  const claimsFor = (messageId: string, consumer = 'domain-events') =>
    db
      .select()
      .from(schema.inbox)
      .where(and(eq(schema.inbox.consumer, consumer), eq(schema.inbox.messageId, messageId)));
  const retryRowsFor = (messageId: string) =>
    db.select().from(schema.consumerRetries).where(eq(schema.consumerRetries.messageId, messageId));

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('publishing', () => {
    beforeAll(async () => {
      ({ app, pool, db } = await createTestAppWithPool());
      relay = app.get(OutboxRelay);
    });
    closeAppAfterAll(() => app);
    resetDatabaseBeforeEach(() => pool);
    snapshotTransportBeforeEach(() => app);

    it('publishes an outbox row to its topic, keyed on the aggregate, with the four headers', async () => {
      const [row] = await seed(1, { traceparent: TRACEPARENT });

      await expect(relay.runOnce(10)).resolves.toEqual({ published: 1, failed: 0 });

      const [event] = await publishedEnvelopes(app);
      expect(event.unverified).toBeUndefined();
      expect(event.record?.topic).toMatch(/\.order\.events$/);
      expect(event.record?.key).toBe(row.aggregateId);
      expect(event.record?.headers).toEqual({
        message_id: row.id,
        event_type: 'order.placed',
        traceparent: expect.stringContaining('4bf92f3577b34da6a3ce929d0e0e4736') as unknown,
        [SIGNATURE_HEADER]: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown,
      });
      expect((await rowsById([row.id]))[0].publishedAt).toBeInstanceOf(Date);
    });

    it('collapses a row published twice into one effect', async () => {
      const effect = spyOnEffect(app.get(DomainEventDispatcher));
      const [row] = await seed(1);

      await relay.runOnce(10);
      expect((await deliverPublished(app)).map(({ result }) => result)).toEqual(['processed']);

      await db.update(schema.outbox).set({ publishedAt: null }).where(eq(schema.outbox.id, row.id));
      await relay.runOnce(10);
      expect((await deliverPublished(app)).map(({ result }) => result)).toEqual(['duplicate']);

      expect(effect).toHaveBeenCalledTimes(1);
      expect(await claimsFor(row.id)).toHaveLength(1);
    });

    // Known defect. Intended: a row the transport permanently refuses reaches a terminal state.
    // Actual: OutboxRelay increments `attempts` and nothing reads it; only the backlog alerts in
    // slo-burn-rate.yml would notice the row.
    it('retries a permanently refused row forever without ever escalating it', async () => {
      const [poison] = await seed(1, { aggregateType: 'Refund', eventType: 'refund.issued' });

      // The relay charges an attempt only when a sibling in the batch got through. The tick count sits
      // past any plausible escalation threshold, so adding one turns this test red.
      const TICKS_PAST_ANY_PLAUSIBLE_THRESHOLD = 12;
      for (let tick = 0; tick < TICKS_PAST_ANY_PLAUSIBLE_THRESHOLD; tick += 1) {
        await seed(1);
        await expect(relay.runOnce(10)).resolves.toEqual({ published: 1, failed: 1 });
      }

      const [stuck] = await db.select().from(schema.outbox).where(isNull(schema.outbox.publishedAt));
      expect(stuck.id).toBe(poison.id);
      expect(stuck.attempts).toBe(TICKS_PAST_ANY_PLAUSIBLE_THRESHOLD);
      expect(await claimsFor(poison.id)).toHaveLength(0);
      expect(await retryRowsFor(poison.id)).toHaveLength(0);

      // Alone it is never sent, so it neither costs an attempt nor reads as the broker being down.
      await expect(relay.runOnce(10)).resolves.toEqual({ published: 0, failed: 1 });
      expect((await rowsById([poison.id]))[0].attempts).toBe(TICKS_PAST_ANY_PLAUSIBLE_THRESHOLD);
      expect(app.get<DomainEventPublisher>(DOMAIN_EVENT_PUBLISHER).ready()).toBe(true);
    });
  });

  describe('consuming', () => {
    let dispatcher: DomainEventDispatcher;
    let signingKey: string;

    beforeAll(async () => {
      clearMetricsRegistry();
      ({ app, pool, db } = await createTestAppWithPool({
        QUEUE_WORKER_ENABLED: 'true',
        METRICS_TOKEN: E2E_METRICS_TOKEN,
      }));
      relay = app.get(OutboxRelay);
      dispatcher = app.get(DomainEventDispatcher);
      signingKey = app.get(ConfigService).getOrThrow<string>('messaging.signingKey');
      await untilJoined(app);
      // A new group starts from the beginning, which holds what the cases above published.
      await vi.waitFor(async () => {
        expect(await consumerLag(app, 'domain-events')).toBe(0);
        expect(await consumerLag(app, 'catalog-search')).toBe(0);
      }, WAIT);
    });
    closeAppAfterAll(() => app);
    resetDatabaseBeforeEach(() => pool);
    snapshotTransportBeforeEach(() => app);

    const caughtUp = () => vi.waitFor(async () => expect(await consumerLag(app, 'domain-events')).toBe(0), WAIT);
    const signed = (envelope: DomainEventJob, key = signingKey) => {
      const value = Buffer.from(JSON.stringify(envelope));
      return { value, key: envelope.aggregateId, headers: { [SIGNATURE_HEADER]: signValue(key, value) } };
    };

    it('applies a published event once and commits past it', async () => {
      const series = 'messaging_consume_total{event_type="order.placed",result="processed"}';
      const before = sample(await scrape(app), series);
      const [row] = await seed(1);

      await relay.runOnce(10);

      await vi.waitFor(async () => expect(await claimsFor(row.id)).toHaveLength(1), WAIT);
      expect(sample(await scrape(app), series)).toBe(before + 1);
      await caughtUp();
    });

    it('parks a failing message without holding up the next one on its partition', async () => {
      spyOnEffect(dispatcher).mockRejectedValueOnce(new Error('connection reset'));
      const aggregateId = testId();
      const sameOrder = { aggregateId, payload: { orderId: aggregateId, totalAmountMinor: 150_000 } };
      const [failing] = await seed(1, sameOrder);
      const [next] = await seed(1, sameOrder);

      await relay.runOnce(10);

      await vi.waitFor(async () => expect(await claimsFor(next.id)).toHaveLength(1), WAIT);
      expect(await retryRowsFor(failing.id)).toMatchObject([{ status: 'pending' }]);
      expect(await claimsFor(failing.id)).toHaveLength(0);
      await caughtUp();
    });

    // Without the wait the client hands the message straight back, and every round writes nothing.
    it('backs off on a message whose retry row cannot be written, instead of redelivering it hot', async () => {
      const deliveredAt: number[] = [];
      spyOnEffect(dispatcher).mockImplementation(() => {
        deliveredAt.push(Date.now());
        return Promise.reject(new Error('handler refused'));
      });
      const park = vi
        .spyOn(app.get(ConsumerRetryStore), 'park')
        .mockRejectedValue(new Error('Connection terminated unexpectedly'));
      const [row] = await seed(1);

      await relay.runOnce(10);
      await vi.waitFor(() => expect(deliveredAt.length).toBeGreaterThan(0), WAIT);
      await sleep(3_000 - (Date.now() - deliveredAt[0]));

      const inWindow = deliveredAt.filter((at) => at - deliveredAt[0] < 3_000);
      expect(inWindow.length).toBeGreaterThanOrEqual(2);
      expect(inWindow.length).toBeLessThanOrEqual(4);
      expect(await consumerLag(app, 'domain-events')).toBe(1);

      park.mockRestore();
      await vi.waitFor(async () => expect(await retryRowsFor(row.id)).toMatchObject([{ status: 'pending' }]), WAIT);
      await caughtUp();
    });

    it('keeps catalog events in a group of their own, so a backlog of them never delays an order', async () => {
      const catalogCount = 200;
      vi.spyOn(app.get(ProductChangedHandler), 'apply').mockImplementation(() => sleep(20));
      const products = await seed(catalogCount, {
        aggregateType: 'Product',
        eventType: 'catalog.product.changed',
        payload: {},
      });
      await expect(relay.runOnce(500)).resolves.toEqual({ published: catalogCount, failed: 0 });
      const [order] = await seed(1);
      await relay.runOnce(10);

      await vi.waitFor(async () => expect(await claimsFor(order.id)).toHaveLength(1), WAIT);
      const catalogClaims = () => db.select().from(schema.inbox).where(eq(schema.inbox.consumer, 'catalog-search'));
      expect((await catalogClaims()).length).toBeLessThan(catalogCount);

      await vi.waitFor(async () => expect(await catalogClaims()).toHaveLength(catalogCount), {
        ...WAIT,
        timeout: 30_000,
      });
      expect(await claimsFor(products[0].id, 'catalog-search')).toHaveLength(1);
      const published = await publishedEnvelopes(app);
      const catalogTopics = new Set(
        published.filter(({ envelope }) => envelope?.aggregateType === 'Product').map(({ record }) => record?.topic),
      );
      expect([...catalogTopics]).toEqual([expect.stringMatching(/\.catalog\.events$/)]);
    });

    it('exports consumer lag for both groups', async () => {
      await vi.waitFor(async () => {
        const text = await scrape(app);
        expect(text).toContain('messaging_consumer_lag{group="domain-events"');
        expect(text).toContain('messaging_consumer_lag{group="catalog-search"');
      }, WAIT);
    });

    it('drops an unsigned message without a claim or a retry row, and counts it', async () => {
      const before = sample(await scrape(app), UNVERIFIED);
      const [row] = await seed(1, { publishedAt: new Date() });
      const value = Buffer.from(JSON.stringify(envelopeOf(row)));

      await produceRaw(app, { topic: 'order.events', value, key: row.aggregateId });

      await vi.waitFor(async () => expect(sample(await scrape(app), UNVERIFIED)).toBe(before + 1), WAIT);
      await caughtUp();
      expect(await claimsFor(row.id)).toHaveLength(0);
      expect(await retryRowsFor(row.id)).toHaveLength(0);
    });

    it('drops a message signed with another key', async () => {
      const before = sample(await scrape(app), UNVERIFIED);
      const [row] = await seed(1, { publishedAt: new Date() });

      await produceRaw(app, { topic: 'order.events', ...signed(envelopeOf(row), 'f'.repeat(64)) });

      await vi.waitFor(async () => expect(sample(await scrape(app), UNVERIFIED)).toBe(before + 1), WAIT);
      await caughtUp();
      expect(await claimsFor(row.id)).toHaveLength(0);
      expect(await retryRowsFor(row.id)).toHaveLength(0);
    });

    it('drops a signed message produced to the wrong topic', async () => {
      const before = sample(await scrape(app), UNVERIFIED);
      const [row] = await seed(1, { publishedAt: new Date() });

      await produceRaw(app, { topic: 'payment.events', ...signed(envelopeOf(row)) });

      await vi.waitFor(async () => expect(sample(await scrape(app), UNVERIFIED)).toBe(before + 1), WAIT);
      await caughtUp();
      expect(await claimsFor(row.id)).toHaveLength(0);
      expect(await retryRowsFor(row.id)).toHaveLength(0);
    });

    it('applies a correctly signed message produced past the relay', async () => {
      const [row] = await seed(1, { publishedAt: new Date() });

      await produceRaw(app, { topic: 'order.events', ...signed(envelopeOf(row)) });

      await vi.waitFor(async () => expect(await claimsFor(row.id)).toHaveLength(1), WAIT);
      await caughtUp();
    });
  });

  describe('alongside BullMQ', () => {
    let queue: Queue<DomainEventJob>;

    beforeAll(async () => {
      ({ app, pool, db } = await createTestAppWithPool({
        MESSAGING_TRANSPORT: 'bullmq',
        QUEUE_WORKER_ENABLED: 'true',
      }));
      relay = app.get(OutboxRelay);
      queue = app.get<Queue<DomainEventJob>>(DOMAIN_EVENTS_QUEUE);
    });
    closeAppAfterAll(() => app);
    resetDatabaseBeforeEach(() => pool);
    obliterateQueueBeforeEach(() => [queue]);

    it('drains BullMQ while the Kafka consumers run alongside it', async () => {
      const effect = spyOnEffect(app.get(DomainEventDispatcher));
      const [row] = await seed(1);

      await expect(relay.runOnce(10)).resolves.toEqual({ published: 1, failed: 0 });

      await vi.waitFor(async () => expect(await claimsFor(row.id)).toHaveLength(1), WAIT);
      const completed: Job<DomainEventJob>[] = await queue.getJobs(['completed']);
      expect(completed.filter((job) => job.data.outboxId === row.id)).toHaveLength(1);
      expect(effect).toHaveBeenCalledTimes(1);
      await untilJoined(app);
    });
  });

  // A broker of its own: the shared one serves every file running in parallel.
  describe('broker loss after the producer connected', () => {
    const DELIVERY_TIMEOUT_MS = 1_000;
    let broker: { container: StartedTestContainer; brokers: string; port: number };
    let publisher: DomainEventPublisher;
    let prefix: string;

    beforeAll(async () => {
      broker = await startKafka();
      clearMetricsRegistry();
      ({ app, pool, db } = await createTestAppWithPool({
        KAFKA_BROKERS: broker.brokers,
        KAFKA_DELIVERY_TIMEOUT_MS: String(DELIVERY_TIMEOUT_MS),
        BREAKER_RESET_TIMEOUT_MS: '3000',
        METRICS_TOKEN: E2E_METRICS_TOKEN,
      }));
      relay = app.get(OutboxRelay);
      publisher = app.get<DomainEventPublisher>(DOMAIN_EVENT_PUBLISHER);
      prefix = app.get(ConfigService).getOrThrow<string>('kafka.prefix');
    }, 180_000);

    afterAll(async () => {
      await app?.close();
      await broker?.container.stop();
    });
    resetDatabaseBeforeEach(() => pool);

    it('holds the backlog while the broker is gone, then drains it from a new broker at the same address', async () => {
      await seed(1);
      await expect(relay.runOnce(10)).resolves.toEqual({ published: 1, failed: 0 });

      await broker.container.stop();
      const stranded = await seed(3);
      const ids = stranded.map((row) => row.id);

      const startedAt = Date.now();
      await expect(relay.runOnce(10)).resolves.toEqual({ published: 0, failed: 3 });
      expect(Date.now() - startedAt).toBeLessThan(DELIVERY_TIMEOUT_MS * 2);
      expect((await rowsById(ids)).map((row) => row.attempts)).toEqual([0, 0, 0]);

      expect(publisher.ready()).toBe(false);
      const backlog = sample(await scrape(app), 'outbox_backlog_pending');
      expect(backlog).toBe(3);
      const transaction = vi.spyOn(db, 'transaction');
      await expect(relay.runOnce(10)).resolves.toEqual({ published: 0, failed: 0 });
      expect(transaction).not.toHaveBeenCalled();
      expect(sample(await scrape(app), 'outbox_backlog_pending')).toBe(backlog);

      broker = await startKafka({ port: broker.port });
      await reprovisionSpecTopics(broker.brokers, prefix);

      // The client redials on its own backoff, up to 10s apart, so a window can close before it has.
      const ticks: Array<{ published: number; failed: number }> = [];
      await vi.waitFor(
        async () => {
          if (publisher.ready()) ticks.push(await relay.runOnce(10));
          expect(ticks.at(-1)).toEqual({ published: 3, failed: 0 });
        },
        { timeout: 60_000, interval: 250 },
      );
      expect(sample(await scrape(app), 'outbox_backlog_pending')).toBe(0);
      expect((await rowsById(ids)).map((row) => row.attempts)).toEqual([0, 0, 0]);
    }, 180_000);
  });
});
