import type { INestApplication } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import type { Pool } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import type { DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import { DrizzleIdempotencyKeyRepository } from '../../src/modules/order/infrastructure/drizzle-idempotency-key.repository';
import { closeAppAfterAll, createTestAppWithPool, resetDatabaseBeforeEach } from '../setup/harness';

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const KEY = '9f8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const REQUEST_HASH = 'a'.repeat(64);

const scopeOf = (userId: string) => `user:${userId}`;
const inDays = (days: number) => new Date(Date.now() + days * 24 * 60 * 60 * 1000);

describe('Idempotency-key store (integration, real Postgres)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;
  let repo: DrizzleIdempotencyKeyRepository;

  const insertInput = (
    overrides: Partial<Parameters<DrizzleIdempotencyKeyRepository['tryInsertInProgress']>[0]> = {},
  ) => ({
    scope: scopeOf(USER_A),
    key: KEY,
    requestHash: REQUEST_HASH,
    method: 'POST',
    path: '/orders',
    expiresAt: inDays(1),
    ...overrides,
  });

  async function countRows(scope: string, key: string): Promise<number> {
    const rows = await db
      .select({ id: schema.idempotencyKeys.id })
      .from(schema.idempotencyKeys)
      .where(and(eq(schema.idempotencyKeys.scope, scope), eq(schema.idempotencyKeys.key, key)));
    return rows.length;
  }

  beforeAll(async () => {
    ({ app, pool, db } = await createTestAppWithPool());
    repo = new DrizzleIdempotencyKeyRepository(db);
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  it('returns null on a duplicate (scope, key) without throwing, keeping one row', async () => {
    await repo.tryInsertInProgress(insertInput());

    const second = await repo.tryInsertInProgress(insertInput({ requestHash: 'b'.repeat(64) }));

    expect(second).toBeNull();
    expect(await countRows(scopeOf(USER_A), KEY)).toBe(1);
  });

  it('isolates keys per user scope', async () => {
    const first = await repo.tryInsertInProgress(insertInput({ scope: scopeOf(USER_A) }));
    const second = await repo.tryInsertInProgress(insertInput({ scope: scopeOf(USER_B) }));

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(await countRows(scopeOf(USER_A), KEY)).toBe(1);
    expect(await countRows(scopeOf(USER_B), KEY)).toBe(1);
  });

  it('rolls markCompleted back with the caller transaction', async () => {
    await repo.tryInsertInProgress(insertInput());

    await expect(
      db.transaction(async (tx) => {
        await repo.markCompleted(
          { scope: scopeOf(USER_A), key: KEY, responseStatus: 201, responseBody: { ok: true } },
          tx,
        );
        throw new Error('force rollback');
      }),
    ).rejects.toThrow('force rollback');

    const record = await repo.findByScopeAndKey(scopeOf(USER_A), KEY);
    expect(record).toMatchObject({ status: 'IN_PROGRESS', responseStatus: null });
  });

  it('deleteInProgress removes only an IN_PROGRESS row', async () => {
    await repo.tryInsertInProgress(insertInput());

    await repo.deleteInProgress(scopeOf(USER_A), KEY);
    expect(await repo.findByScopeAndKey(scopeOf(USER_A), KEY)).toBeNull();

    await repo.tryInsertInProgress(insertInput({ key: 'k2' }));
    await repo.markCompleted({ scope: scopeOf(USER_A), key: 'k2', responseStatus: 201, responseBody: { ok: true } });
    await repo.deleteInProgress(scopeOf(USER_A), 'k2');
    expect(await repo.findByScopeAndKey(scopeOf(USER_A), 'k2')).not.toBeNull();
  });

  it('deleteExpired reclaims past-TTL rows and keeps live ones', async () => {
    await repo.tryInsertInProgress(insertInput({ key: 'expired', expiresAt: inDays(-1) }));
    await repo.tryInsertInProgress(insertInput({ key: 'live', expiresAt: inDays(1) }));

    const removed = await repo.deleteExpired(new Date(), 100);

    expect(removed).toBe(1);
    expect(await repo.findByScopeAndKey(scopeOf(USER_A), 'expired')).toBeNull();
    expect(await repo.findByScopeAndKey(scopeOf(USER_A), 'live')).not.toBeNull();
  });

  it('deleteExpiredInProgress removes only an IN_PROGRESS row created before the cutoff', async () => {
    await repo.tryInsertInProgress(insertInput({ key: 'live' }));
    await repo.tryInsertInProgress(insertInput({ key: 'stale' }));
    await repo.tryInsertInProgress(insertInput({ key: 'done' }));
    await repo.markCompleted({ scope: scopeOf(USER_A), key: 'done', responseStatus: 201, responseBody: { ok: true } });

    // The port has no createdAt override (it is always "now" at insert), so backdating the rows that
    // should look abandoned goes straight at the table — the way a real crash's aftermath does.
    await db
      .update(schema.idempotencyKeys)
      .set({ createdAt: new Date(Date.now() - 60_000) })
      .where(inArray(schema.idempotencyKeys.key, ['stale', 'done']));

    const cutoff = new Date(Date.now() - 30_000);
    const removed = await Promise.all(
      ['live', 'stale', 'done'].map((key) => repo.deleteExpiredInProgress(scopeOf(USER_A), key, cutoff)),
    );

    expect(removed).toEqual([0, 1, 0]);
    expect(await repo.findByScopeAndKey(scopeOf(USER_A), 'live')).not.toBeNull();
    expect(await repo.findByScopeAndKey(scopeOf(USER_A), 'stale')).toBeNull();
    expect(await repo.findByScopeAndKey(scopeOf(USER_A), 'done')).not.toBeNull();
  });
});
