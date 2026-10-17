import type { INestApplication } from '@nestjs/common';
import { eq, isNull } from 'drizzle-orm';
import type { Pool } from 'pg';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import { ConsumerDelivery, type DeliveryOutcome } from '../../src/shared/messaging/consume/consumer-delivery';
import { DomainEventDispatcher } from '../../src/shared/messaging/handlers/domain-event.dispatcher';
import { OutboxRelay } from '../../src/shared/messaging/outbox/outbox-relay';
import {
  DrizzleOutboxWindowStore,
  republishOutbox,
  type RepublishWindow,
} from '../../src/shared/messaging/outbox/republish-outbox';
import { DOMAIN_EVENTS_CONSUMER } from '../../src/shared/messaging/queue/queue.constants';
import { spyOnEffect } from '../setup/dispatcher-effect.helper';
import { closeAppAfterAll, createTestAppWithPool, resetDatabaseBeforeEach } from '../setup/harness';
import { testId } from '../setup/id-service-stub';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const RETENTION = { inboxDays: 30, outboxDays: 30 };
const WAIT = { timeout: 10_000, interval: 50 };

// A real consumer rather than `drainDomainEvents`: the point here is that a group already past the
// first copy still delivers the republished one.
describe('Outbox republish window (integration, real Postgres + Redis)', () => {
  let app: INestApplication;
  let db: DrizzleDB;
  let pool: Pool;
  let relay: OutboxRelay;
  let dispatcher: DomainEventDispatcher;
  let delivery: ConsumerDelivery;
  let windows: DrizzleOutboxWindowStore;

  beforeAll(async () => {
    ({ app, pool, db } = await createTestAppWithPool({ QUEUE_WORKER_ENABLED: 'true' }));
    relay = app.get(OutboxRelay);
    dispatcher = app.get(DomainEventDispatcher);
    delivery = app.get(ConsumerDelivery);
    windows = new DrizzleOutboxWindowStore(db);
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const seed = async (
    rows: { eventType?: string; createdAgoMs?: number; published?: boolean }[],
  ): Promise<(typeof schema.outbox.$inferSelect)[]> => {
    const now = Date.now();
    return db
      .insert(schema.outbox)
      .values(
        rows.map(({ eventType = 'order.placed', createdAgoMs = MINUTE_MS, published = true }) => {
          const orderId = testId();
          return {
            id: testId(),
            aggregateType: 'Order',
            aggregateId: orderId,
            eventType,
            payload: { orderId, totalAmountMinor: 150_000 },
            createdAt: new Date(now - createdAgoMs),
            publishedAt: published ? new Date(now) : null,
          };
        }),
      )
      .returning();
  };

  const republish = (window: RepublishWindow, dryRun = false) =>
    republishOutbox(windows, { window, dryRun, retention: RETENTION });

  const unpublishedIds = async () =>
    (await db.select({ id: schema.outbox.id }).from(schema.outbox).where(isNull(schema.outbox.publishedAt))).map(
      (row) => row.id,
    );

  const recordOutcomes = () => {
    const outcomes: { outboxId: string; result: DeliveryOutcome }[] = [];
    const deliver = delivery.deliver.bind(delivery) as ConsumerDelivery['deliver'];
    vi.spyOn(delivery, 'deliver').mockImplementation(async (consumer, job) => {
      const result = await deliver(consumer, job);
      outcomes.push({ outboxId: job.outboxId, result });
      return result;
    });
    return (outboxId: string) => outcomes.filter((o) => o.outboxId === outboxId).map((o) => o.result);
  };

  it('redelivers a republished row as a new job and the inbox swallows the copy', async () => {
    const effect = spyOnEffect(dispatcher).mockResolvedValue(undefined);
    const outcomesFor = recordOutcomes();
    const [row] = await seed([{ published: false }]);

    await expect(relay.runOnce(10)).resolves.toMatchObject({ published: 1 });
    await vi.waitFor(() => expect(outcomesFor(row.id)).toHaveLength(1), WAIT);

    await expect(republish({ sinceMs: HOUR_MS, eventTypes: [] })).resolves.toMatchObject({ reset: 1 });
    await expect(relay.runOnce(10)).resolves.toMatchObject({ published: 1 });
    await vi.waitFor(() => expect(outcomesFor(row.id)).toHaveLength(2), WAIT);

    expect(outcomesFor(row.id)).toEqual(['processed', 'duplicate']);
    expect(effect).toHaveBeenCalledTimes(1);
    expect(await db.select().from(schema.inbox).where(eq(schema.inbox.messageId, row.id))).toHaveLength(1);
  });

  // A previous republish moved `published_at` forward; the claim it guards was swept by `processed_at`.
  it('picks rows by when they were created, not when they were last published', async () => {
    const [inside] = await seed([{ createdAgoMs: 10 * MINUTE_MS }, { createdAgoMs: 2 * HOUR_MS }]);

    await expect(republish({ sinceMs: HOUR_MS, eventTypes: [] })).resolves.toMatchObject({ reset: 1 });

    expect(await unpublishedIds()).toEqual([inside.id]);
  });

  it('resets only the event types asked for', async () => {
    const [, paid] = await seed([{ eventType: 'order.placed' }, { eventType: 'order.paid' }]);

    await expect(republish({ sinceMs: HOUR_MS, eventTypes: ['order.paid'] })).resolves.toMatchObject({ reset: 1 });

    expect(await unpublishedIds()).toEqual([paid.id]);
  });

  it('counts rows per event type and the copies each consumer will swallow on a dry run', async () => {
    const [placed, , paid] = await seed([
      { eventType: 'order.placed' },
      { eventType: 'order.placed' },
      { eventType: 'order.paid' },
      { eventType: 'order.paid', createdAgoMs: 2 * HOUR_MS },
    ]);
    await db.insert(schema.inbox).values([
      { id: testId(), consumer: DOMAIN_EVENTS_CONSUMER, messageId: placed.id, eventType: placed.eventType },
      { id: testId(), consumer: DOMAIN_EVENTS_CONSUMER, messageId: paid.id, eventType: paid.eventType },
      { id: testId(), consumer: 'search-sync', messageId: paid.id, eventType: paid.eventType },
    ]);

    const report = await republish({ sinceMs: HOUR_MS, eventTypes: [] }, true);

    expect(report).toEqual({
      byEventType: [
        { eventType: 'order.paid', rows: 1 },
        { eventType: 'order.placed', rows: 2 },
      ],
      claimsByConsumer: [
        { consumer: DOMAIN_EVENTS_CONSUMER, rows: 2 },
        { consumer: 'search-sync', rows: 1 },
      ],
      reset: 0,
    });
    expect(await unpublishedIds()).toEqual([]);
  });

  it('changes nothing when the CLI runs without --apply', async () => {
    await seed([{ eventType: 'order.placed' }, { eventType: 'order.paid' }]);
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => void lines.push(line));
    const argv = process.argv;
    process.argv = [argv[0], 'republish-outbox.cli.ts', '--since', '1h'];

    try {
      // Extensioned because `import()` resolves in ESM mode under nodenext, even from a CJS file.
      await import('../../src/shared/messaging/outbox/republish-outbox.cli.js');
      await vi.waitFor(() => expect(lines.some((line) => line.includes('--apply'))).toBe(true), WAIT);
    } finally {
      process.argv = argv;
    }

    expect(lines.join('\n')).toMatch(/dry run[\s\S]*order\.paid\s+1[\s\S]*order\.placed\s+1/);
    expect(await unpublishedIds()).toEqual([]);
  });
});
