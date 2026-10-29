import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import type { DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import { RetentionScheduler, RetentionSweepRegistry, type RetentionSweep } from '@jcool/platform/retention';
import { closeAppAfterAll, createTestAppWithPool, resetDatabaseBeforeEach } from '../setup/harness';
import { E2E_METRICS_TOKEN, metricsAuthHeader } from '../setup/metrics.helper';
import { testId } from '../setup/id-service-stub';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);
const hoursFromNow = (hours: number) => new Date(Date.now() + hours * HOUR_MS);
const ORDER_ID = testId();
const USER_ID = testId();
const STALE_MESSAGE_ID = testId();
const YOUNG_MESSAGE_ID = testId();

// Chosen so every boundary below can be crossed with a row a few days either side of it, and every
// one is at or above the floor `env.validation.ts` enforces.
const WINDOWS = {
  METRICS_TOKEN: E2E_METRICS_TOKEN,
  RETENTION_OUTBOX_DAYS: '30',
  RETENTION_INBOX_DAYS: '7',
  RETENTION_IDEMPOTENCY_GRACE_SEC: '0',
  RETENTION_REJECTED_ORDER_DAYS: '30',
};

// Each table exists to make some retry safe, so every test asserts on the survivor: over-collecting
// looks correct until a retry. Sweeps are driven directly, since a timer tick would race the test.
describe('Retention sweeps (integration, real Postgres)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;
  let registry: RetentionSweepRegistry;
  let scheduler: RetentionScheduler;

  const sweepNamed = (name: string): RetentionSweep => {
    const sweep = registry.all().find((s) => s.name === name);
    if (!sweep) throw new Error(`no retention sweep named "${name}"`);
    return sweep;
  };

  const outboxRow = (overrides: Partial<typeof schema.outbox.$inferInsert> = {}) => ({
    id: testId(),
    aggregateType: 'Order',
    aggregateId: ORDER_ID,
    eventType: 'order.placed',
    payload: { orderId: ORDER_ID },
    ...overrides,
  });

  const idempotencyRow = (key: string, expiresAt: Date, status: 'IN_PROGRESS' | 'COMPLETED' = 'IN_PROGRESS') => ({
    id: testId(),
    scope: `user:${USER_ID}`,
    key,
    requestHash: 'a'.repeat(64),
    status,
    method: 'POST',
    path: '/orders',
    expiresAt,
  });

  const keysLeft = async () =>
    (await db.select({ key: schema.idempotencyKeys.key }).from(schema.idempotencyKeys)).map((r) => r.key);

  const orderRow = (status: 'REJECTED' | 'CANCELLED', finalizedAt: Date) => ({
    id: testId(),
    userId: USER_ID,
    status,
    currency: 'VND',
    totalAmount: 100_000,
    placedAt: finalizedAt,
    finalizedAt,
  });

  beforeAll(async () => {
    ({ app, pool, db } = await createTestAppWithPool(WINDOWS));
    registry = app.get(RetentionSweepRegistry);
    scheduler = app.get(RetentionScheduler);
  });

  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  // A sweep that was never registered produces no error and no metric; the table just grows.
  it('registers a sweep for every table with a retention rule', () => {
    expect([...registry.names()].sort()).toEqual([
      'media:assets',
      'messaging:inbox',
      'messaging:outbox',
      'order:idempotency-keys',
      'order:rejected-orders',
    ]);
  });

  describe('messaging:outbox', () => {
    // An unpublished row is the relay's work queue, an unsent event rather than a stale record.
    it('keeps unpublished rows at any age and published ones inside the window', async () => {
      await db
        .insert(schema.outbox)
        .values([
          outboxRow({ eventType: 'unsent', createdAt: daysAgo(100), publishedAt: null }),
          outboxRow({ eventType: 'old', createdAt: daysAgo(31), publishedAt: daysAgo(31) }),
          outboxRow({ eventType: 'recent', createdAt: daysAgo(29), publishedAt: daysAgo(29) }),
        ]);

      const deleted = await sweepNamed('messaging:outbox').sweep(500);

      expect(deleted).toBe(1);
      const left = await db.select({ eventType: schema.outbox.eventType }).from(schema.outbox);
      expect(left.map((row) => row.eventType).sort()).toEqual(['recent', 'unsent']);
    });
  });

  describe('messaging:inbox', () => {
    // A correctness bound, not housekeeping: delete a claim while the queue can still redeliver its
    // message and the effect is applied twice.
    it('keeps a claim young enough for its message to still come back', async () => {
      await db.insert(schema.inbox).values([
        {
          id: testId(),
          consumer: 'order-events',
          messageId: STALE_MESSAGE_ID,
          eventType: 'order.placed',
          processedAt: daysAgo(8),
        },
        {
          id: testId(),
          consumer: 'order-events',
          messageId: YOUNG_MESSAGE_ID,
          eventType: 'order.placed',
          processedAt: daysAgo(6),
        },
      ]);

      const deleted = await sweepNamed('messaging:inbox').sweep(500);

      expect(deleted).toBe(1);
      const left = await db.select({ messageId: schema.inbox.messageId }).from(schema.inbox);
      expect(left).toEqual([{ messageId: YOUNG_MESSAGE_ID }]);
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

  describe('order:rejected-orders', () => {
    // Only REJECTED is disposable: every other terminal order is the buyer's record.
    it('collects a REJECTED order past the window with its lines, and keeps everything else', async () => {
      const stale = orderRow('REJECTED', daysAgo(31));
      const recent = orderRow('REJECTED', daysAgo(29));
      const cancelled = orderRow('CANCELLED', daysAgo(100));
      await db.insert(schema.orders).values([stale, recent, cancelled]);
      await db.insert(schema.orderItems).values({
        id: testId(),
        orderId: stale.id,
        skuId: testId(),
        productName: 'Tee',
        unitPrice: 100_000,
        quantity: 1,
      });

      const deleted = await sweepNamed('order:rejected-orders').sweep(500);

      expect(deleted).toBe(1);
      const left = await db.select({ id: schema.orders.id }).from(schema.orders);
      expect(left.map((row) => row.id).sort()).toEqual([recent.id, cancelled.id].sort());
      expect(await db.select().from(schema.orderItems)).toHaveLength(0);
    });

    it('deletes no more than the batch allows', async () => {
      await db.insert(schema.orders).values([1, 2, 3].map(() => orderRow('REJECTED', daysAgo(31))));

      expect(await sweepNamed('order:rejected-orders').sweep(2)).toBe(2);
      expect(await db.select().from(schema.orders)).toHaveLength(1);
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

      const { text } = await request(app.getHttpServer()).get('/metrics').set(metricsAuthHeader()).expect(200);

      // Every registered sweep has a series after one tick, so none is silently missing.
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
