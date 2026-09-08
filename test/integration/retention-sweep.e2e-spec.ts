import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { IdentityService } from '../../src/shared/identity';
import { DRIZZLE, PG_POOL, type DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import { normalizeEmail } from '../../src/shared/kernel/normalize-email';
import { RetentionSweepRegistry, type RetentionSweep } from '../../src/shared/retention';
import { RetentionScheduler } from '../../src/shared/retention/retention.scheduler';
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
  // Zero, so "collectable" means exactly "past its own expiry" and the test asserts the predicate
  // rather than the slack around it. The shipped defaults add a week.
  RETENTION_AUTH_TOKEN_GRACE_DAYS: '0',
  RETENTION_REFRESH_TOKEN_GRACE_DAYS: '30',
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
  let identity: IdentityService;

  const sweepNamed = (name: string): RetentionSweep => {
    const sweep = registry.all().find((s) => s.name === name);
    if (!sweep) throw new Error(`no retention sweep named "${name}" — registration is what makes it run`);
    return sweep;
  };

  /** Every token table hangs off a user by FK, so a fixture user has to exist first. */
  async function insertUser(email: string): Promise<string> {
    const id = identity.mintUserId(normalizeEmail(email));
    await db.insert(schema.users).values({ id, email, passwordHash: 'not-a-real-hash' });
    return id;
  }

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
    identity = app.get(IdentityService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
  });

  // A sweep that was never registered produces no error and no metric — the table simply stops
  // being collected.
  it('registers a sweep for every table with a retention rule', () => {
    expect([...registry.names()].sort()).toEqual([
      'auth-tokens:email-verification',
      'auth-tokens:password-reset',
      'auth-tokens:refresh',
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

  describe('auth-tokens', () => {
    it.each([
      ['auth-tokens:email-verification', schema.emailVerificationTokens] as const,
      ['auth-tokens:password-reset', schema.passwordResetTokens] as const,
    ])('%s keeps a token that can still be spent', async (name, table) => {
      const userId = await insertUser(`${name.replace(/[:.]/g, '-')}@example.com`);
      const row = (suffix: string, expiresAt: Date, consumedAt: Date | null = null) => ({
        id: identity.mintOwnedBy(userId),
        userId,
        tokenHash: `${suffix}-${'0'.repeat(40)}`,
        expiresAt,
        consumedAt,
      });
      await db.insert(table).values([
        row('live', hoursFromNow(1)),
        row('expired', daysAgo(1)),
        // Already spent: `consume` can never match it again, so it is collectable on the same clock.
        row('consumed', hoursFromNow(1), daysAgo(1)),
      ]);

      const deleted = await sweepNamed(name).sweep(500);

      expect(deleted).toBe(2);
      const left = await db.select({ tokenHash: table.tokenHash }).from(table);
      expect(left).toEqual([{ tokenHash: `live-${'0'.repeat(40)}` }]);
    });

    // Expiry is age, revocation is evidence — collecting a revoked token on the expiry clock turns
    // a detected replay back into a successful refresh.
    it('auth-tokens:refresh keeps a revoked token far longer than an expired one', async () => {
      const userId = await insertUser('refresh-retention@example.com');
      const row = (suffix: string, expiresAt: Date, revokedAt: Date | null = null) => ({
        id: identity.mintOwnedBy(userId),
        userId,
        tokenHash: `${suffix}-${'0'.repeat(40)}`,
        familyId: '0198f0d8-5555-7000-8000-000000000001',
        expiresAt,
        revokedAt,
      });
      await db.insert(schema.refreshTokens).values([
        row('live', hoursFromNow(1)),
        row('expired', daysAgo(1)),
        // Revoked but still inside the 30-day reuse-detection horizon, and NOT yet expired.
        row('revoked-recently', hoursFromNow(1), daysAgo(10)),
        // Revoked AND long since expired — the shape rotation actually produces. `rotate` checks
        // revoked/replaced before expiry, so this row still answers "that token came back" and must
        // outlive its expiry by the REVOCATION grace; an expiry arm without `revoked_at IS NULL`
        // collects it here.
        row('revoked-and-expired', daysAgo(8), daysAgo(10)),
        row('revoked-long-ago', hoursFromNow(1), daysAgo(40)),
      ]);

      const deleted = await sweepNamed('auth-tokens:refresh').sweep(500);

      expect(deleted).toBe(2);
      const left = await db.select({ tokenHash: schema.refreshTokens.tokenHash }).from(schema.refreshTokens);
      expect(left.map((r) => r.tokenHash).sort()).toEqual([
        `live-${'0'.repeat(40)}`,
        `revoked-and-expired-${'0'.repeat(40)}`,
        `revoked-recently-${'0'.repeat(40)}`,
      ]);
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
