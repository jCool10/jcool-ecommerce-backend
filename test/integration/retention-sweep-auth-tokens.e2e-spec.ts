import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { IdentityService } from '@shared/identity';
import { DRIZZLE, PG_POOL, type DrizzleDB } from '@shared/infrastructure/database/drizzle.tokens';
import * as schema from '@user/database/schema';
import { normalizeEmail } from '@shared/kernel/normalize-email';
import { RetentionSweepRegistry, type RetentionSweep } from '@shared/retention';
import { resetDatabase } from '../setup/reset-database';
import { createUserApp } from '../setup/test-app.factory';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);
const hoursFromNow = (hours: number) => new Date(Date.now() + hours * HOUR_MS);

const WINDOWS = {
  // Zero, so "collectable" means exactly "past its own expiry" and the test asserts the predicate
  // rather than the slack around it. The shipped defaults add a week.
  RETENTION_AUTH_TOKEN_GRACE_DAYS: '0',
  RETENTION_REFRESH_TOKEN_GRACE_DAYS: '30',
};

/**
 * The other half of the retention roster: these three tables moved to user-service with the auth
 * module, and each exists to make some retry safe — so every test asserts on the SURVIVOR.
 */
describe('Auth-token retention sweeps (integration, real Postgres)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;
  let registry: RetentionSweepRegistry;
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

  beforeAll(async () => {
    app = await createUserApp(WINDOWS);
    pool = app.get<Pool>(PG_POOL);
    db = app.get<DrizzleDB>(DRIZZLE);
    registry = app.get(RetentionSweepRegistry);
    identity = app.get(IdentityService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
  });

  // Exactly three, and none of commerce-core's five: a sweep registered on the wrong side would run
  // against a database that does not have its table.
  it('registers a sweep for each of the three token tables it owns', () => {
    expect([...registry.names()].sort()).toEqual([
      'auth-tokens:email-verification',
      'auth-tokens:password-reset',
      'auth-tokens:refresh',
    ]);
  });

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
