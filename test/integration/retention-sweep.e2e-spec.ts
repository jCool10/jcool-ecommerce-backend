import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DRIZZLE, PG_POOL, type DrizzleDB } from '@shared/infrastructure/database/drizzle.tokens';
import * as schema from '@commerce-core/database/schema';
import { RetentionSweepRegistry, type RetentionSweep } from '@shared/retention';
import { RetentionScheduler } from '@shared/retention/retention.scheduler';
import { resetDatabase } from '../setup/reset-database';
import { createTestApp } from '../setup/test-app.factory';

const METRICS_TOKEN = 'e2e-retention-metrics-token';
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);
const hoursFromNow = (hours: number) => new Date(Date.now() + hours * HOUR_MS);

// Chosen so every boundary below can be crossed with a row a few days either side of it, and every
// one is at or above the floor `env.validation.ts` enforces.
const WINDOWS = {
  METRICS_TOKEN,
  RETENTION_OUTBOX_DAYS: '30',
  RETENTION_INBOX_DAYS: '7',
  RETENTION_WEBHOOK_EVENT_DAYS: '14',
  RETENTION_IDEMPOTENCY_GRACE_SEC: '0',
};

/**
 * Every test inserts a row on each side of the boundary and asserts on the SURVIVOR: each of these
 * tables exists to make some retry safe, so over-collecting produces a correct-looking app that
 * fails only under retry. Sweeps are driven directly — a timer tick would delete the row under test.
 */
describe('Retention sweeps (integration, real Postgres)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;
  let registry: RetentionSweepRegistry;
  let scheduler: RetentionScheduler;

  const sweepNamed = (name: string): RetentionSweep => {
    const sweep = registry.all().find((s) => s.name === name);
    if (!sweep) throw new Error(`no retention sweep named "${name}" — registration is what makes it run`);
    return sweep;
  };

  const outboxRow = (overrides: Partial<typeof schema.outbox.$inferInsert> = {}) => ({
    aggregateType: 'Order',
    aggregateId: '0198f0d8-3333-7000-8000-000000000001',
    eventType: 'order.placed',
    payload: { orderId: '0198f0d8-3333-7000-8000-000000000001' },
    ...overrides,
  });

  const webhookRow = (providerEventId: string, receivedAt: Date) => ({
    provider: 'stripe',
    providerEventId,
    type: 'payment_intent.succeeded',
    payload: { id: providerEventId },
    receivedAt,
  });

  const idempotencyRow = (key: string, expiresAt: Date, status: 'IN_PROGRESS' | 'COMPLETED' = 'IN_PROGRESS') => ({
    scope: 'user:0198f0d8-3333-7000-8000-000000000001',
    key,
    requestHash: 'a'.repeat(64),
    status,
    method: 'POST',
    path: '/orders',
    expiresAt,
  });

  const keysLeft = async () =>
    (await db.select({ key: schema.idempotencyKeys.key }).from(schema.idempotencyKeys)).map((r) => r.key);

  beforeAll(async () => {
    app = await createTestApp(WINDOWS);
    pool = app.get<Pool>(PG_POOL);
    db = app.get<DrizzleDB>(DRIZZLE);
    registry = app.get(RetentionSweepRegistry);
    scheduler = app.get(RetentionScheduler);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
  });

  // A sweep that was never registered produces no error and no metric — the table simply stops
  // being collected.
  // The three `auth-tokens:*` sweeps are deliberately absent: those tables live in user-service, and
  // a sweep registered here would run against a database that no longer has them.
  it('registers a sweep for every table with a retention rule', () => {
    expect([...registry.names()].sort()).toEqual([
      'media:assets',
      'messaging:inbox',
      'messaging:outbox',
      'order:idempotency-keys',
      'payment:webhook-events',
    ]);
  });

  describe('messaging:outbox', () => {
    it('never collects an unpublished row, however old — that is an unsent event, not a stale record', async () => {
      await db.insert(schema.outbox).values([
        // A hundred days old and still the relay's work queue — no age makes it collectable.
        outboxRow({ createdAt: daysAgo(100), publishedAt: null }),
        outboxRow({ eventType: 'order.paid', createdAt: daysAgo(60), publishedAt: daysAgo(60) }),
      ]);

      const deleted = await sweepNamed('messaging:outbox').sweep(500);

      expect(deleted).toBe(1);
      const [survivor] = await db.select().from(schema.outbox);
      expect(survivor).toMatchObject({ eventType: 'order.placed', publishedAt: null });
    });

    it('keeps a row published inside the window', async () => {
      await db
        .insert(schema.outbox)
        .values([
          outboxRow({ eventType: 'old', createdAt: daysAgo(31), publishedAt: daysAgo(31) }),
          outboxRow({ eventType: 'recent', createdAt: daysAgo(29), publishedAt: daysAgo(29) }),
        ]);

      await sweepNamed('messaging:outbox').sweep(500);

      const left = await db.select({ eventType: schema.outbox.eventType }).from(schema.outbox);
      expect(left).toEqual([{ eventType: 'recent' }]);
    });
  });

  describe('messaging:inbox', () => {
    // A correctness bound, not housekeeping: delete a claim while the queue can still redeliver its
    // message and the effect is applied twice.
    it('keeps a claim young enough for its message to still come back', async () => {
      await db.insert(schema.inbox).values([
        {
          consumer: 'domain-events',
          messageId: '0198f0d8-4444-7000-8000-000000000001',
          eventType: 'order.placed',
          processedAt: daysAgo(8),
        },
        {
          consumer: 'domain-events',
          messageId: '0198f0d8-4444-7000-8000-000000000002',
          eventType: 'order.placed',
          processedAt: daysAgo(6),
        },
      ]);

      const deleted = await sweepNamed('messaging:inbox').sweep(500);

      expect(deleted).toBe(1);
      const left = await db.select({ messageId: schema.inbox.messageId }).from(schema.inbox);
      expect(left).toEqual([{ messageId: '0198f0d8-4444-7000-8000-000000000002' }]);
    });
  });

  describe('order:idempotency-keys', () => {
    // The dangerous over-collection: a COMPLETED row is the frozen response a retry replays, so
    // deleting one early turns the next retry of POST /orders into a second order.
    it('keeps a COMPLETED key that has not expired, and collects one that has', async () => {
      await db
        .insert(schema.idempotencyKeys)
        .values([
          idempotencyRow('completed-live', hoursFromNow(1), 'COMPLETED'),
          idempotencyRow('completed-expired', daysAgo(1), 'COMPLETED'),
          idempotencyRow('in-progress-live', hoursFromNow(1)),
          idempotencyRow('in-progress-expired', daysAgo(1)),
        ]);

      const deleted = await sweepNamed('order:idempotency-keys').sweep(500);

      // Status is deliberately not part of the predicate in either direction: expiry alone decides.
      expect(deleted).toBe(2);
      expect((await keysLeft()).sort()).toEqual(['completed-live', 'in-progress-live']);
    });

    it('deletes no more than the batch allows, so one tick cannot lock the table', async () => {
      await db
        .insert(schema.idempotencyKeys)
        .values([1, 2, 3, 4, 5].map((n) => idempotencyRow(`expired-${n}`, daysAgo(1))));

      expect(await sweepNamed('order:idempotency-keys').sweep(2)).toBe(2);
      expect(await keysLeft()).toHaveLength(3);
    });
  });

  describe('payment:webhook-events', () => {
    // The window here is the GATEWAY's redelivery window, not the queue's: this table is read only
    // at ingress, where the unique (provider, provider_event_id) turns a repeat into a no-op.
    it('keeps an event the gateway could still redeliver', async () => {
      await db
        .insert(schema.webhookEvents)
        .values([webhookRow('evt_old', daysAgo(15)), webhookRow('evt_recent', daysAgo(13))]);

      const deleted = await sweepNamed('payment:webhook-events').sweep(500);

      expect(deleted).toBe(1);
      const left = await db
        .select({ providerEventId: schema.webhookEvents.providerEventId })
        .from(schema.webhookEvents);
      expect(left).toEqual([{ providerEventId: 'evt_recent' }]);
    });
  });

  // Registered last: the registry has no way to remove a sweep, so a permanently failing one added
  // here would follow every test that came after it.
  describe('fault isolation across a tick', () => {
    it('keeps sweeping every other table when one throws', async () => {
      registry.register({
        name: 'test:always-fails',
        sweep: () => Promise.reject(new Error('relation does not exist')),
      });
      await db.insert(schema.outbox).values(outboxRow({ createdAt: daysAgo(60), publishedAt: daysAgo(60) }));
      await db.insert(schema.idempotencyKeys).values(idempotencyRow('expired', daysAgo(1)));

      // A single try/catch around the tick would have let the first failure take the rest with it.
      await expect(scheduler.tick()).resolves.toBeUndefined();

      expect(await db.select().from(schema.outbox)).toHaveLength(0);
      expect(await keysLeft()).toHaveLength(0);

      const { text } = await request(app.getHttpServer())
        .get('/metrics')
        .set('Authorization', `Bearer ${METRICS_TOKEN}`)
        .expect(200);

      // Every registered sweep has a series after ONE tick, so none is silently missing from the
      // roster. That the TIMER starts late enough to see them all is a separate claim, asserted in
      // `retention.scheduler.spec.ts`; this suite drives `tick()` directly.
      for (const name of registry.names()) {
        if (name === 'test:always-fails') continue;
        expect(text).toContain(`retention_rows_deleted_total{sweep="${name}"}`);
      }
      // A sweep that deletes nothing and one that cannot run are indistinguishable from the rows
      // counter alone, which is why the failure counter is separate and per label.
      expect(text).toContain('retention_sweep_failures_total{sweep="test:always-fails"} 1');
      expect(text).toContain('retention_rows_deleted_total{sweep="messaging:outbox"} 1');
      expect(text).not.toContain('retention_sweep_failures_total{sweep="messaging:outbox"}');
    });
  });
});
