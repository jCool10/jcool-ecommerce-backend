import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { normalizeEmail } from '@jcool/kernel';
import { RetentionScheduler, RetentionSweepRegistry, type RetentionSweep } from '@jcool/platform/retention';
import type { DrizzleDB } from '../../src/database';
import * as schema from '../../src/database/schema';
import { IdentityService } from '../../src/modules/user/application/services/identity.service';
import { closeAppAfterAll, createTestAppWithPool, resetDatabaseBeforeEach } from '../setup/harness';
import { E2E_METRICS_TOKEN, metricsAuthHeader } from '../setup/metrics.helper';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);
const hoursFromNow = (hours: number) => new Date(Date.now() + hours * HOUR_MS);

const WINDOWS = {
  METRICS_TOKEN: E2E_METRICS_TOKEN,
  // Zero, so "collectable" means exactly "past its own expiry".
  RETENTION_AUTH_TOKEN_GRACE_DAYS: '0',
  RETENTION_REFRESH_TOKEN_GRACE_DAYS: '30',
};

/**
 * Each test puts a row on both sides of a boundary and asserts on the survivor: over-collecting
 * looks correct until a retry needs the row. Sweeps are driven directly; a timer tick would race.
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

  async function insertUser(email: string): Promise<string> {
    const id = await identity.mintUserId(normalizeEmail(email));
    await db.insert(schema.users).values({ id, email, passwordHash: 'not-a-real-hash' });
    return id;
  }

  beforeAll(async () => {
    ({ app, pool, db } = await createTestAppWithPool(WINDOWS));
    registry = app.get(RetentionSweepRegistry);
    scheduler = app.get(RetentionScheduler);
    identity = app.get(IdentityService);
  });

  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  // An unregistered sweep raises no error and no metric; the table just stops being collected.
  it('registers a sweep for every token table', () => {
    expect([...registry.names()].sort()).toEqual([
      'auth-tokens:email-verification',
      'auth-tokens:password-reset',
      'auth-tokens:refresh',
    ]);
  });

  describe('auth-tokens', () => {
    it.each([
      ['auth-tokens:email-verification', schema.emailVerificationTokens] as const,
      ['auth-tokens:password-reset', schema.passwordResetTokens] as const,
    ])('%s keeps a token that can still be spent', async (name, table) => {
      const userId = await insertUser(`${name.replace(/[:.]/g, '-')}@example.com`);
      const row = async (suffix: string, expiresAt: Date, consumedAt: Date | null = null) => ({
        id: await identity.mintOwnedBy(userId),
        userId,
        tokenHash: `${suffix}-${'0'.repeat(40)}`,
        expiresAt,
        consumedAt,
      });
      await db.insert(table).values([
        await row('live', hoursFromNow(1)),
        await row('expired', daysAgo(1)),
        // Spent: `consume` can never match it again.
        await row('consumed', hoursFromNow(1), daysAgo(1)),
      ]);

      const deleted = await sweepNamed(name).sweep(500);

      expect(deleted).toBe(2);
      const left = await db.select({ tokenHash: table.tokenHash }).from(table);
      expect(left).toEqual([{ tokenHash: `live-${'0'.repeat(40)}` }]);
    });

    // Revocation is evidence: collecting a revoked token on the expiry clock turns a detected
    // replay back into a successful refresh.
    it('auth-tokens:refresh keeps a revoked token far longer than an expired one', async () => {
      const userId = await insertUser('refresh-retention@example.com');
      const row = async (suffix: string, expiresAt: Date, revokedAt: Date | null = null) => ({
        id: await identity.mintOwnedBy(userId),
        userId,
        tokenHash: `${suffix}-${'0'.repeat(40)}`,
        familyId: '0198f0d8-5555-7000-8000-000000000001',
        expiresAt,
        revokedAt,
      });
      await db.insert(schema.refreshTokens).values([
        await row('live', hoursFromNow(1)),
        await row('expired', daysAgo(1)),
        await row('revoked-recently', hoursFromNow(1), daysAgo(10)),
        // The shape rotation produces: still answers "that token came back" past its expiry.
        await row('revoked-and-expired', daysAgo(8), daysAgo(10)),
        await row('revoked-long-ago', hoursFromNow(1), daysAgo(40)),
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

  // Last: the registry cannot unregister, so this sweep follows every test after it.
  describe('fault isolation across a tick', () => {
    it('keeps sweeping every other table when one throws', async () => {
      registry.register({
        name: 'test:always-fails',
        sweep: () => Promise.reject(new Error('relation does not exist')),
      });
      const userId = await insertUser('fault-isolation@example.com');
      await db.insert(schema.emailVerificationTokens).values({
        id: await identity.mintOwnedBy(userId),
        userId,
        tokenHash: `expired-${'0'.repeat(40)}`,
        expiresAt: daysAgo(1),
      });

      await expect(scheduler.tick()).resolves.toBeUndefined();

      expect(await db.select().from(schema.emailVerificationTokens)).toHaveLength(0);

      const { text } = await request(app.getHttpServer()).get('/metrics').set(metricsAuthHeader()).expect(200);

      for (const name of registry.names()) {
        if (name === 'test:always-fails') continue;
        expect(text).toContain(`retention_rows_deleted_total{sweep="${name}"}`);
      }
      // Deleting nothing and failing to run look the same on the rows counter alone.
      expect(text).toContain('retention_sweep_failures_total{sweep="test:always-fails"} 1');
      expect(text).toContain('retention_rows_deleted_total{sweep="auth-tokens:email-verification"} 1');
      expect(text).not.toContain('retention_sweep_failures_total{sweep="auth-tokens:email-verification"}');
    });
  });
});
