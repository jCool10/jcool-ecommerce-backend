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
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);
const PRODUCT_ID = testId();
const STALE_MESSAGE_ID = testId();
const YOUNG_MESSAGE_ID = testId();

// Chosen so every boundary below can be crossed with a row a few days either side of it, and every
// one is at or above the floor `env.validation.ts` enforces.
const WINDOWS = {
  METRICS_TOKEN: E2E_METRICS_TOKEN,
  RETENTION_OUTBOX_DAYS: '30',
  RETENTION_INBOX_DAYS: '7',
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
    aggregateType: 'Product',
    aggregateId: PRODUCT_ID,
    eventType: 'catalog.product.changed',
    payload: { productId: PRODUCT_ID },
    ...overrides,
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
    expect([...registry.names()].sort()).toEqual(['media:assets', 'messaging:inbox', 'messaging:outbox']);
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
          consumer: 'api-events',
          messageId: STALE_MESSAGE_ID,
          eventType: 'catalog.product.changed',
          processedAt: daysAgo(8),
        },
        {
          id: testId(),
          consumer: 'api-events',
          messageId: YOUNG_MESSAGE_ID,
          eventType: 'catalog.product.changed',
          processedAt: daysAgo(6),
        },
      ]);

      const deleted = await sweepNamed('messaging:inbox').sweep(500);

      expect(deleted).toBe(1);
      const left = await db.select({ messageId: schema.inbox.messageId }).from(schema.inbox);
      expect(left).toEqual([{ messageId: YOUNG_MESSAGE_ID }]);
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

      // A single try/catch around the tick would have let the first failure take the rest with it.
      await expect(scheduler.tick()).resolves.toBeUndefined();

      expect(await db.select().from(schema.outbox)).toHaveLength(0);

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
