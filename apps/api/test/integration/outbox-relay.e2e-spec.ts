import type { INestApplication } from '@nestjs/common';
import { eq, inArray, isNull } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import { OutboxRelay } from '../../src/shared/messaging/outbox/outbox-relay';
import { QUEUE_CONNECTION } from '../../src/shared/messaging/queue/queue.constants';
import {
  DOMAIN_EVENT_PUBLISHER,
  type DomainEventPublisher,
} from '../../src/shared/messaging/transport/domain-event-publisher.port';
import { publishedEnvelopes, snapshotTransportBeforeEach, type PublishedEvent } from '../setup/domain-event-transport';
import { closeAppAfterAll, createTestAppWithPool, resetDatabaseBeforeEach } from '../setup/harness';
import { withClientDown } from '../setup/redis-outage';
import { createTestApp } from '../setup/test-app.factory';
import { testId } from '../setup/id-service-stub';

const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

const seedRow = (overrides: Record<string, unknown> = {}, orderId = testId()) => ({
  id: testId(),
  aggregateType: 'Order',
  aggregateId: orderId,
  eventType: 'order.placed',
  payload: { orderId, totalAmountMinor: 150_000 },
  ...overrides,
});

// Rows are seeded directly and the scheduler is off, so every tick here is one the test asked for.
describe('Outbox relay (integration, real Postgres + Redis)', () => {
  let app: INestApplication;
  let relay: OutboxRelay;
  let publisher: DomainEventPublisher;
  let db: DrizzleDB;
  let pool: Pool;

  beforeAll(async () => {
    ({ app, pool, db } = await createTestAppWithPool());
    relay = app.get(OutboxRelay);
    publisher = app.get<DomainEventPublisher>(DOMAIN_EVENT_PUBLISHER);
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);
  snapshotTransportBeforeEach(() => app);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const seed = (count: number, overrides: Record<string, unknown> = {}) =>
    db
      .insert(schema.outbox)
      .values(Array.from({ length: count }, () => seedRow(overrides)))
      .returning();

  const unpublished = () => db.select().from(schema.outbox).where(isNull(schema.outbox.publishedAt));
  const byId = async (id: string) => (await db.select().from(schema.outbox).where(eq(schema.outbox.id, id)))[0];

  it('publishes every unpublished row once and leaves nothing for the next tick', async () => {
    const rows = await seed(3);

    await expect(relay.runOnce(10)).resolves.toEqual({ published: 3, failed: 0 });

    const published = await publishedEnvelopes(app);
    expect(published.map((event) => event.envelope?.outboxId).sort()).toEqual(rows.map((row) => row.id).sort());
    expect(await unpublished()).toHaveLength(0);

    // A published row is off the work queue for good: the partial index no longer sees it.
    await expect(relay.runOnce(10)).resolves.toEqual({ published: 0, failed: 0 });
    expect(await publishedEnvelopes(app)).toEqual([]);
  });

  it('carries the whole envelope, keyed on the outbox row so a redelivery collapses', async () => {
    const [row] = await seed(1, { traceparent: TRACEPARENT });

    await relay.runOnce(10);

    const [event] = await publishedEnvelopes(app);
    // The inbox dedups on the envelope's outboxId; the record key only keeps an aggregate in order.
    expect(event.record).toMatchObject({
      topic: expect.stringMatching(/\.order\.events$/) as unknown,
      key: row.aggregateId,
      headers: { message_id: row.id, event_type: 'order.placed' },
    });
    expect(event.envelope).toEqual({
      outboxId: row.id,
      aggregateType: 'Order',
      aggregateId: row.aggregateId,
      eventType: 'order.placed',
      payload: row.payload,
      occurredAt: row.createdAt.toISOString(),
      // Trace id, not the whole header: with an SDK registered the relay re-injects under its own
      // publish span, so only the trace has to survive the hop.
      traceparent: expect.stringContaining('4bf92f3577b34da6a3ce929d0e0e4736') as unknown,
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
    // One refusal with a healthy sibling in the batch: the broker is demonstrably working, so the
    // row itself is what was rejected and the attempt is charged to it.
    const publish = publisher.publish.bind(publisher);
    vi.spyOn(publisher, 'publish').mockImplementationOnce(async ([refused, ...rest]) => [
      { rowId: refused.rowId, ok: false, error: new Error('broker rejected the message') },
      ...(await publish(rest)),
    ]);

    await expect(relay.runOnce(10)).resolves.toEqual({ published: 1, failed: 1 });

    const stuck = await unpublished();
    expect(stuck).toHaveLength(1);
    expect(stuck[0].attempts).toBe(1);

    vi.restoreAllMocks();
    await expect(relay.runOnce(10)).resolves.toEqual({ published: 1, failed: 0 });
    expect(await publishedEnvelopes(app)).toHaveLength(2);
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

    // Plain FOR UPDATE would block here until the holder commits, which only happens after this
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

    const [first, second] = await Promise.all([relay.runOnce(10), relay.runOnce(10)]);

    expect(first.published + second.published).toBe(10);
    expect(first.failed + second.failed).toBe(0);
    // Counted on the topics, which keep every send: a double publish would show up as an eleventh.
    const published = await publishedEnvelopes(app);
    expect(new Set(published.map((event) => event.envelope?.outboxId)).size).toBe(10);
    expect(published).toHaveLength(10);
    expect(await unpublished()).toHaveLength(0);
  });

  // The module registers a timer that calls runOnce; every other test drives it by hand.
  it('drains the backlog on its own once the interval elapses', async () => {
    const scheduled = await createTestApp({ OUTBOX_RELAY_ENABLED: 'true', OUTBOX_POLL_MS: '100' });
    try {
      await db.insert(schema.outbox).values(seedRow());

      // The message is sent inside the tick's transaction, so the mark can land a moment later.
      const published: PublishedEvent[] = [];
      await vi.waitFor(
        async () => {
          published.push(...(await publishedEnvelopes(app)));
          expect(published).toHaveLength(1);
          expect(await unpublished()).toHaveLength(0);
        },
        { timeout: 10_000, interval: 50 },
      );
    } finally {
      await scheduled.close();
    }
  });

  describe('over BullMQ', () => {
    let bullmq: INestApplication;
    let bullmqDb: DrizzleDB;

    beforeAll(async () => {
      ({ app: bullmq, db: bullmqDb } = await createTestAppWithPool({ MESSAGING_TRANSPORT: 'bullmq' }));
    });

    afterAll(async () => {
      await bullmq.close();
    });

    it('leaves the backlog untouched while Redis is away, then drains it on recovery', async () => {
      const [row] = await seed(1);
      const bullmqRelay = bullmq.get(OutboxRelay);
      const connection = bullmq.get<Redis>(QUEUE_CONNECTION);
      const txSpy = vi.spyOn(bullmqDb, 'transaction');

      await withClientDown(connection, async () => {
        // ioredis flips `status` on the socket's close event, not on the disconnect call, so this tick
        // still passes the pre-flight and fails inside the batch, the window a real drop lands in.
        await expect(bullmqRelay.runOnce(10)).resolves.toEqual({ published: 0, failed: 1 });

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
        await expect(bullmqRelay.runOnce(10)).resolves.toEqual({ published: 0, failed: 0 });
        expect(txSpy).not.toHaveBeenCalled();
      });

      await expect(bullmqRelay.runOnce(10)).resolves.toEqual({ published: 1, failed: 0 });
    });
  });
});
