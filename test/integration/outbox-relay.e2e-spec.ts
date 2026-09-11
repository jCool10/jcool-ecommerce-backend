import type { INestApplication } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { eq, inArray, isNull } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import { OutboxRelay } from '../../src/shared/messaging/outbox/outbox-relay';
import type { DomainEventJob } from '../../src/shared/messaging/queue/domain-event.job';
import { DOMAIN_EVENTS_QUEUE, QUEUE_CONNECTION } from '../../src/shared/messaging/queue/queue.constants';
import { authHeader } from '../setup/auth.helper';
import { seedSellableSku, buyerWithCart } from '../setup/fixtures/order-flow.fixture';
import {
  closeAppAfterAll,
  createTestAppWithPool,
  obliterateQueueBeforeEach,
  resetDatabaseBeforeEach,
} from '../setup/harness';
import { idempotencyKeyHeader } from '../setup/idempotency.helper';
import { withClientDown } from '../setup/redis-outage';
import { createTestApp } from '../setup/test-app.factory';

const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

const seedRow = (index: number, overrides: Record<string, unknown> = {}) => ({
  aggregateType: 'Order',
  aggregateId: `0198f0d8-1111-7000-8000-${String(index).padStart(12, '0')}`,
  eventType: 'order.placed',
  payload: { orderId: `0198f0d8-1111-7000-8000-${String(index).padStart(12, '0')}`, totalAmountMinor: 150_000 },
  ...overrides,
});

/**
 * The bridge between the two stores: Postgres holds the truth, Redis carries it onward. Rows are
 * seeded directly — how they get written is the append suite's concern; this one starts where a
 * committed row does. The scheduler is off in e2e, so every tick here is one this file asked for.
 */
describe('Outbox relay (integration, real Postgres + Redis)', () => {
  let app: INestApplication;
  let relay: OutboxRelay;
  let queue: Queue;
  let connection: Redis;
  let db: DrizzleDB;
  let pool: Pool;

  beforeAll(async () => {
    ({ app, pool, db } = await createTestAppWithPool());
    relay = app.get(OutboxRelay);
    queue = app.get<Queue>(DOMAIN_EVENTS_QUEUE);
    connection = app.get<Redis>(QUEUE_CONNECTION);
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);
  obliterateQueueBeforeEach(() => [queue]);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const seed = (count: number, overrides: Record<string, unknown> = {}) =>
    db
      .insert(schema.outbox)
      .values(Array.from({ length: count }, (_, i) => seedRow(i + 1, overrides)))
      .returning();

  const unpublished = () => db.select().from(schema.outbox).where(isNull(schema.outbox.publishedAt));
  const byId = async (id: string) => (await db.select().from(schema.outbox).where(eq(schema.outbox.id, id)))[0];

  it('publishes every unpublished row once and leaves nothing for the next tick', async () => {
    const rows = await seed(3);

    await expect(relay.runOnce(10)).resolves.toEqual({ published: 3, failed: 0 });

    const jobs = await queue.getJobs(['waiting']);
    expect(jobs.map((job) => job.id).sort()).toEqual(rows.map((row) => row.id).sort());
    expect(await unpublished()).toHaveLength(0);

    // A published row is off the work queue for good — the partial index no longer sees it.
    await expect(relay.runOnce(10)).resolves.toEqual({ published: 0, failed: 0 });
    expect(await queue.getWaitingCount()).toBe(3);
  });

  it('carries the whole envelope, keyed on the outbox row so a redelivery collapses', async () => {
    const [row] = await seed(1, { traceparent: TRACEPARENT });

    await relay.runOnce(10);

    const [job] = await queue.getJobs(['waiting']);
    expect(job.id).toBe(row.id);
    expect(job.name).toBe('order.placed');
    expect(job.data as DomainEventJob).toEqual({
      outboxId: row.id,
      aggregateType: 'Order',
      aggregateId: row.aggregateId,
      eventType: 'order.placed',
      payload: row.payload,
      occurredAt: row.createdAt.toISOString(),
      // Trace id, not the whole header: with an SDK registered the relay re-injects under its own
      // publish span, so only the trace has to survive the hop.
      traceparent: expect.stringContaining('4bf92f3577b34da6a3ce929d0e0e4736'),
    });
  });

  it('never publishes more than the batch size in one tick', async () => {
    await seed(5);

    await expect(relay.runOnce(2)).resolves.toEqual({ published: 2, failed: 0 });

    // The batch bounds how long one transaction holds row locks; the rest simply waits a tick.
    expect(await unpublished()).toHaveLength(3);
  });

  it('keeps an event the queue rejected and delivers it on a later tick', async () => {
    await seed(2);
    // One refusal with a healthy sibling in the batch: the queue is demonstrably working, so the
    // row itself is what was rejected and the attempt is charged to it.
    vi.spyOn(queue, 'add').mockRejectedValueOnce(new Error('queue rejected the payload'));

    await expect(relay.runOnce(10)).resolves.toEqual({ published: 1, failed: 1 });

    const stuck = await unpublished();
    expect(stuck).toHaveLength(1);
    expect(stuck[0].attempts).toBe(1);

    vi.restoreAllMocks();
    await expect(relay.runOnce(10)).resolves.toEqual({ published: 1, failed: 0 });
    expect(await queue.getWaitingCount()).toBe(2);
  });

  it('leaves the backlog untouched while Redis is away, then drains it on recovery', async () => {
    const [row] = await seed(1);
    const txSpy = vi.spyOn(db, 'transaction');

    await withClientDown(connection, async () => {
      // ioredis flips `status` on the socket's close event, not on the disconnect call, so this tick
      // still passes the pre-flight and fails inside the batch — the window a real drop lands in.
      await expect(relay.runOnce(10)).resolves.toEqual({ published: 0, failed: 1 });

      // The decisive assertion: nothing else in the batch got through, so the refusal is read as the
      // queue being down and not as a bad event. An outage must not spend a healthy row's retry
      // budget, or a long enough Redis restart would dead-letter the whole backlog.
      const stalled = await byId(row.id);
      expect(stalled.publishedAt).toBeNull();
      expect(stalled.attempts).toBe(0);

      // Once the status has caught up, the tick costs nothing at all: no transaction, no row locks,
      // no pool client held for the duration of the outage.
      await vi.waitFor(() => expect(connection.status).not.toBe('ready'));
      txSpy.mockClear();
      await expect(relay.runOnce(10)).resolves.toEqual({ published: 0, failed: 0 });
      expect(txSpy).not.toHaveBeenCalled();
    });

    await expect(relay.runOnce(10)).resolves.toEqual({ published: 1, failed: 0 });
  });

  it('skips rows another transaction holds instead of queueing behind them', async () => {
    const rows = await seed(4);
    const held = rows.slice(0, 2).map((row) => row.id);

    let lockTaken!: () => void;
    const taken = new Promise<void>((resolve) => (lockTaken = resolve));
    let releaseLock!: () => void;
    const holder = db.transaction(async (tx) => {
      await tx.select().from(schema.outbox).where(inArray(schema.outbox.id, held)).for('update');
      lockTaken();
      await new Promise<void>((resolve) => (releaseLock = resolve));
    });
    await taken;

    // Plain FOR UPDATE would block here until the holder commits — which only happens after this
    // await returns, so the tick would deadlock rather than return two published rows.
    const startedAt = Date.now();
    await expect(relay.runOnce(10)).resolves.toEqual({ published: 2, failed: 0 });
    expect(Date.now() - startedAt).toBeLessThan(2_000);

    expect((await unpublished()).map((row) => row.id).sort()).toEqual([...held].sort());

    releaseLock();
    await holder;
  });

  it('lets two relays share one backlog without deadlock or double-publish', async () => {
    await seed(10);
    const addSpy = vi.spyOn(queue, 'add');

    const [first, second] = await Promise.all([relay.runOnce(10), relay.runOnce(10)]);

    expect(first.published + second.published).toBe(10);
    expect(first.failed + second.failed).toBe(0);
    // Asserted at the producer, not through the queue: `jobId` would hide a duplicate add.
    expect(addSpy).toHaveBeenCalledTimes(10);
    expect(await unpublished()).toHaveLength(0);
  });

  it('delivers an event written by a real checkout, end to end', async () => {
    const sku = await seedSellableSku(app, { onHand: 5, priceMinor: 150_000 });
    const token = await buyerWithCart(app, sku.variantId, 2);
    const response = await request(app.getHttpServer())
      .post('/orders')
      .set(authHeader(token))
      .set(idempotencyKeyHeader())
      .expect(201);
    const orderId = response.body.id as string;

    await expect(relay.runOnce(10)).resolves.toEqual({ published: 1, failed: 0 });

    const [job] = await queue.getJobs(['waiting']);
    expect(job.name).toBe('order.placed');
    expect((job.data as DomainEventJob).aggregateId).toBe(orderId);
    expect(await unpublished()).toHaveLength(0);
  });

  // Everything above drives runOnce by hand; this proves the module registers a timer that calls it,
  // which is the one part a passing unit test cannot tell us.
  it('drains the backlog on its own once the interval elapses', async () => {
    // A second boot, not a second test: the scheduler is off in the app above, which is what lets
    // every other test own its own tick.
    const scheduled = await createTestApp({ OUTBOX_RELAY_ENABLED: 'true', OUTBOX_POLL_MS: '100' });
    try {
      await db.insert(schema.outbox).values(seedRow(1));

      // The publish alone proves a tick ran; the mark proves its transaction committed. Both are
      // polled: the job reaches the queue inside the transaction, so it is visible for as long as
      // the commit that marks the row takes to land.
      await vi.waitFor(
        async () => {
          expect(await queue.getWaitingCount()).toBe(1);
          expect(await unpublished()).toHaveLength(0);
        },
        { timeout: 10_000, interval: 50 },
      );
    } finally {
      await scheduled.close();
    }
  });
});
