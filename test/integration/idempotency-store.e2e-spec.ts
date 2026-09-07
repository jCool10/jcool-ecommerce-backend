import type { INestApplication } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DRIZZLE, PG_POOL, type DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import { DrizzleIdempotencyKeyRepository } from '../../src/modules/order/infrastructure/drizzle-idempotency-key.repository';
import { resetDatabase } from '../setup/reset-database';
import { createTestApp } from '../setup/test-app.factory';

// Fixed, valid UUIDs — user ids feed the per-user scope.
const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const ORDER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const KEY = '9f8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const REQUEST_HASH = 'a'.repeat(64);

const scopeOf = (userId: string) => `user:${userId}`;
const inDays = (days: number) => new Date(Date.now() + days * 24 * 60 * 60 * 1000);

// Repository contract for the idempotency-key store on real Postgres. Proves the DB-level
// invariants Phases 2/3 lean on: the unique (scope, key) index is the concurrency backstop
// (dup INSERT loses instead of throwing), a COMPLETED row replays its stored response, the
// store is per-user, markCompleted enlists in a caller's transaction, and expired rows are
// reclaimable. The repo is built directly (no request wiring yet — that lands in Phase 2).
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
    app = await createTestApp();
    pool = app.get<Pool>(PG_POOL);
    db = app.get<DrizzleDB>(DRIZZLE);
    repo = new DrizzleIdempotencyKeyRepository(db);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
  });

  it('inserts a fresh IN_PROGRESS record on first use', async () => {
    const record = await repo.tryInsertInProgress(insertInput());

    expect(record).not.toBeNull();
    expect(record).toMatchObject({
      scope: scopeOf(USER_A),
      key: KEY,
      requestHash: REQUEST_HASH,
      status: 'IN_PROGRESS',
      responseStatus: null,
      responseBody: null,
      orderId: null,
      method: 'POST',
      path: '/orders',
    });
    expect(record!.expiresAt).toBeInstanceOf(Date);
  });

  it('returns null on a duplicate (scope, key) without throwing, keeping exactly one row', async () => {
    await repo.tryInsertInProgress(insertInput());

    // A different request hash must NOT create a second row — the unique index wins regardless.
    const second = await repo.tryInsertInProgress(insertInput({ requestHash: 'b'.repeat(64) }));

    expect(second).toBeNull();
    expect(await countRows(scopeOf(USER_A), KEY)).toBe(1);
  });

  it('isolates keys per user — same key under a different scope inserts', async () => {
    const first = await repo.tryInsertInProgress(insertInput({ scope: scopeOf(USER_A) }));
    const second = await repo.tryInsertInProgress(insertInput({ scope: scopeOf(USER_B) }));

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(await countRows(scopeOf(USER_A), KEY)).toBe(1);
    expect(await countRows(scopeOf(USER_B), KEY)).toBe(1);
  });

  it('markCompleted freezes the replayable response', async () => {
    await repo.tryInsertInProgress(insertInput());
    const body = { id: ORDER_ID, status: 'PENDING', total: 12300 };

    await repo.markCompleted({
      scope: scopeOf(USER_A),
      key: KEY,
      responseStatus: 201,
      responseBody: body,
      orderId: ORDER_ID,
    });

    const record = await repo.findByScopeAndKey(scopeOf(USER_A), KEY);
    expect(record).toMatchObject({ status: 'COMPLETED', responseStatus: 201, responseBody: body, orderId: ORDER_ID });
  });

  it('markCompleted enlists in a caller transaction — rolls back with it', async () => {
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

    // The update joined the rolled-back tx: the key is still IN_PROGRESS, so a retry re-runs.
    const record = await repo.findByScopeAndKey(scopeOf(USER_A), KEY);
    expect(record).toMatchObject({ status: 'IN_PROGRESS', responseStatus: null });
  });

  it('deleteInProgress removes only an IN_PROGRESS row', async () => {
    await repo.tryInsertInProgress(insertInput());

    await repo.deleteInProgress(scopeOf(USER_A), KEY);
    expect(await repo.findByScopeAndKey(scopeOf(USER_A), KEY)).toBeNull();

    // A COMPLETED row is a durable result — deleteInProgress must not touch it.
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

  it('deleteExpiredInProgress reclaims only an expired IN_PROGRESS row, leaving a live one', async () => {
    await repo.tryInsertInProgress(insertInput({ key: 'live', expiresAt: inDays(1) }));
    await repo.tryInsertInProgress(insertInput({ key: 'stale', expiresAt: inDays(-1) }));

    const removedLive = await repo.deleteExpiredInProgress(scopeOf(USER_A), 'live', new Date());
    const removedStale = await repo.deleteExpiredInProgress(scopeOf(USER_A), 'stale', new Date());

    // The live row survives, so a concurrent reclaimer that already refreshed it is not clobbered.
    expect(removedLive).toBe(0);
    expect(removedStale).toBe(1);
    expect(await repo.findByScopeAndKey(scopeOf(USER_A), 'live')).not.toBeNull();
    expect(await repo.findByScopeAndKey(scopeOf(USER_A), 'stale')).toBeNull();
  });

  it('deleteExpiredInProgress never removes a COMPLETED row even when past TTL', async () => {
    await repo.tryInsertInProgress(insertInput({ key: 'done', expiresAt: inDays(-1) }));
    await repo.markCompleted({ scope: scopeOf(USER_A), key: 'done', responseStatus: 201, responseBody: { ok: true } });

    const removed = await repo.deleteExpiredInProgress(scopeOf(USER_A), 'done', new Date());

    expect(removed).toBe(0);
    expect(await repo.findByScopeAndKey(scopeOf(USER_A), 'done')).not.toBeNull();
  });
});
