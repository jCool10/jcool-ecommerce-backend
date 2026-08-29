import type { INestApplication } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DRIZZLE, PG_POOL, type DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import { DomainEventDispatcher } from '../../src/shared/messaging/handlers/domain-event.dispatcher';
import { OutboxRelay } from '../../src/shared/messaging/outbox/outbox-relay';
import type { DomainEventJob } from '../../src/shared/messaging/queue/domain-event.job';
import { DomainEventProcessor } from '../../src/shared/messaging/queue/domain-event.processor';
import { DOMAIN_EVENTS_CONSUMER, DOMAIN_EVENTS_QUEUE } from '../../src/shared/messaging/queue/queue.constants';
import { authHeader } from '../setup/auth.helper';
import { buyerWithCart, seedSellableSku } from '../setup/fixtures/order-flow.fixture';
import { idempotencyKeyHeader } from '../setup/idempotency.helper';
import { resetDatabase } from '../setup/reset-database';
import { createTestApp } from '../setup/test-app.factory';

// Pinned rather than inherited from the developer's .env, so the guarded scrape below behaves the
// same on every machine.
const METRICS_TOKEN = 'e2e-consumer-metrics-token';
const MESSAGE_ID = '0198f0d8-0000-7000-8000-000000000001';
const ORDER_ID = '0198f0d8-1111-7000-8000-000000000001';

/**
 * Where at-least-once delivery stops being a problem. The transport can and does deliver twice —
 * the relay may crash after publishing but before marking, the queue redelivers a job whose worker
 * died — and every assertion here is about that second delivery costing nothing.
 *
 * Deliveries are driven by hand: the worker is off in e2e, so nothing consumes behind a test's back.
 */
describe('Idempotent consumer (integration, real Postgres + Redis)', () => {
  let app: INestApplication;
  let processor: DomainEventProcessor;
  let dispatcher: DomainEventDispatcher;
  let relay: OutboxRelay;
  let queue: Queue;
  let db: DrizzleDB;
  let pool: Pool;

  const job = (overrides: Partial<DomainEventJob> = {}): DomainEventJob => ({
    outboxId: MESSAGE_ID,
    aggregateType: 'Order',
    aggregateId: ORDER_ID,
    eventType: 'order.placed',
    payload: { orderId: ORDER_ID, totalAmountMinor: 150_000 },
    occurredAt: '2026-08-24T00:00:00.000Z',
    traceparent: null,
    ...overrides,
  });

  const inboxRows = () => db.select().from(schema.inbox);

  beforeAll(async () => {
    app = await createTestApp({ METRICS_TOKEN });
    processor = app.get(DomainEventProcessor);
    dispatcher = app.get(DomainEventDispatcher);
    relay = app.get(OutboxRelay);
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

  it('applies an event once and records the claim under its consumer group', async () => {
    const effect = vi.spyOn(dispatcher, 'dispatch');

    await expect(processor.process(job())).resolves.toBe('processed');

    expect(effect).toHaveBeenCalledTimes(1);
    const rows = await inboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      // Scoped to the consumer group, so a second consumer of the same event would get its own row
      // rather than being deduped away by this one.
      consumer: DOMAIN_EVENTS_CONSUMER,
      messageId: MESSAGE_ID,
      eventType: 'order.placed',
    });
  });

  it('collapses a redelivery of the same message into a single effect', async () => {
    const effect = vi.spyOn(dispatcher, 'dispatch');

    await expect(processor.process(job())).resolves.toBe('processed');
    await expect(processor.process(job())).resolves.toBe('duplicate');

    expect(effect).toHaveBeenCalledTimes(1);
    expect(await inboxRows()).toHaveLength(1);
  });

  it('dedups on the outbox id, not on the delivery — a fresh job id changes nothing', async () => {
    const effect = vi.spyOn(dispatcher, 'dispatch');

    await processor.process(job());
    // What a BullMQ retry looks like from here: same message, republished after the original job id
    // aged out of retention. Keying on anything per-delivery would let this through.
    await expect(
      processor.process(job({ traceparent: '00-' + '1'.repeat(32) + '-' + '2'.repeat(16) + '-01' })),
    ).resolves.toBe('duplicate');

    expect(effect).toHaveBeenCalledTimes(1);
  });

  it('rolls the claim back when the effect fails, so the redelivery does the work', async () => {
    const effect = vi.spyOn(dispatcher, 'dispatch').mockRejectedValueOnce(new Error('handler exploded'));

    await expect(processor.process(job())).rejects.toThrow('handler exploded');

    // The decisive assertion: no claim survived. Marking the message consumed outside the effect's
    // transaction would have left the event permanently unapplied and permanently deduped.
    expect(await inboxRows()).toHaveLength(0);

    effect.mockRestore();
    await expect(processor.process(job())).resolves.toBe('processed');
    expect(await inboxRows()).toHaveLength(1);
  });

  it('applies each of the order events the producers emit today', async () => {
    for (const [index, eventType] of ['order.placed', 'order.paid', 'order.failed', 'order.expired'].entries()) {
      const outboxId = `0198f0d8-0000-7000-8000-00000000000${index + 1}`;
      await expect(processor.process(job({ outboxId, eventType }))).resolves.toBe('processed');
    }

    expect((await inboxRows()).map((row) => row.eventType).sort()).toEqual([
      'order.expired',
      'order.failed',
      'order.paid',
      'order.placed',
    ]);
  });

  it('fails an event no handler is registered for instead of silently acknowledging it', async () => {
    await expect(processor.process(job({ eventType: 'payment.refunded' }))).rejects.toThrow(/No handler registered/);

    // Nothing claimed: once a handler exists, the redelivery still has an event to apply.
    expect(await inboxRows()).toHaveLength(0);
  });

  it('reports both outcomes on /metrics', async () => {
    await processor.process(job());
    await processor.process(job());

    const { text } = await request(app.getHttpServer())
      .get('/metrics')
      .set('Authorization', `Bearer ${METRICS_TOKEN}`)
      .expect(200);

    // Presence, not value: counters accumulate across the tests in this file, so only a delta would
    // be meaningful (the registry itself is per-file — vitest isolates each e2e file in its own
    // process).
    expect(text).toContain('messaging_consume_total{event_type="order.placed",result="processed"}');
    expect(text).toContain('messaging_consume_total{event_type="order.placed",result="duplicate"}');
  });

  it('carries a real checkout from HTTP through the relay to a consumed effect', async () => {
    const worker = await createTestApp({ QUEUE_WORKER_ENABLED: 'true' });
    try {
      const sku = await seedSellableSku(app, { onHand: 5, priceMinor: 150_000 });
      const token = await buyerWithCart(app, sku.variantId, 2);
      const response = await request(app.getHttpServer())
        .post('/orders')
        .set(authHeader(token))
        .set(idempotencyKeyHeader())
        .expect(201);
      const orderId = response.body.id as string;

      await expect(relay.runOnce(10)).resolves.toEqual({ published: 1, failed: 0 });

      // The one thing only a running worker can prove: the queue actually hands jobs to the
      // processor, rather than every test above calling it directly.
      await vi.waitFor(async () => expect(await inboxRows()).toHaveLength(1), { timeout: 10_000, interval: 50 });
      const [claimed] = await inboxRows();
      expect(claimed.eventType).toBe('order.placed');

      const [outboxRow] = await db.select().from(schema.outbox).where(eq(schema.outbox.aggregateId, orderId));
      expect(claimed.messageId).toBe(outboxRow.id);
    } finally {
      await worker.close();
    }
  });
});
