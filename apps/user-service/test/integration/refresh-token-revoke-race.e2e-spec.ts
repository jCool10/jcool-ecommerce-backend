import type { INestApplication } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashRefreshToken } from '../../src/modules/user/application/hash-refresh-token';
import { authHeader, loginAs, sessionFrom, sessionHeaders, type Session } from '../setup/auth.helper';
import { closeAppAfterAll, createTestAppWithPool, resetDatabaseBeforeEach } from '../setup/harness';
import { waitForLockWaiters } from '../setup/lock-waiters.helper';

/**
 * Reproduces the race a single READ COMMITTED `UPDATE ... WHERE revoked_at IS NULL` loses to a
 * concurrent `rotate()`: the revoke blocks on the presented leaf's row lock, then re-reads it as
 * already revoked without ever seeing the successor `rotate()` inserted — a statement snapshot never
 * includes a row committed after it started. `holdLeafRowLock` stands in for the moment `rotate()`
 * would otherwise hold that same row lock, so the test controls exactly when the rotation is allowed
 * to complete relative to the revoke racing it.
 */
describe('Revoking a user/family races a concurrent rotation (integration, real Postgres)', () => {
  let app: INestApplication;
  let pool: Pool;

  const email = 'revoke-race@test.local';
  const password = 'Password123!';

  beforeAll(async () => {
    ({ app, pool } = await createTestAppWithPool());
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  beforeEach(async () => {
    await request(app.getHttpServer()).post('/auth/register').send({ email, password }).expect(201);
  });

  const refresh = (session: Session) => request(app.getHttpServer()).post('/auth/refresh').set(sessionHeaders(session));

  const familyRowsOf = async (session: Session) => {
    const { rows } = await pool.query<{ revoked_at: Date | null }>(
      `SELECT revoked_at FROM refresh_tokens
        WHERE family_id = (SELECT family_id FROM refresh_tokens WHERE token_hash = $1)`,
      [hashRefreshToken(session.refreshToken)],
    );
    return rows;
  };

  async function holdLeafRowLock(session: Session): Promise<PoolClient> {
    const holder = await pool.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT 1 FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE', [
      hashRefreshToken(session.refreshToken),
    ]);
    return holder;
  }

  // supertest only writes the request once something subscribes via `.then`/`.end` — assigning the
  // bare `Test` to a variable for later `Promise.all` leaves it unsent, so it never reaches the lock
  // it is supposed to race. This subscribes immediately and hands back a plain settled-later promise.
  const fire = (req: request.Test): Promise<request.Response> => req.then((res) => res);

  it('revokeAllForUser also revokes the successor of a rotation that was in flight', async () => {
    const session = await loginAs(app, { email, password });
    const holder = await holdLeafRowLock(session);

    const rotating = fire(refresh(session));
    let revokingAll: Promise<request.Response>;
    try {
      await waitForLockWaiters(pool, 1); // the rotation is parked on the leaf row lock the holder took
      revokingAll = fire(request(app.getHttpServer()).post('/auth/logout-all').set(authHeader(session.accessToken)));
      await waitForLockWaiters(pool, 2); // logout-all is parked behind the rotation's shared user lock
    } finally {
      await holder.query('COMMIT');
      holder.release();
    }

    const [rotateRes, revokeRes] = await Promise.all([rotating, revokingAll]);

    // The rotation that was already in flight still completes...
    expect(rotateRes.status).toBe(200);
    // ...but revoke-all, which ran after it, still catches the successor it left behind.
    expect(revokeRes.status).toBe(204);

    const rows = await familyRowsOf(session);
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.every((row) => row.revoked_at !== null)).toBe(true);
    await refresh(sessionFrom(rotateRes)).expect(401);
  });

  it('revokeFamily also revokes the successor of a rotation that was in flight, answering 204 not 404', async () => {
    const session = await loginAs(app, { email, password });
    const { rows: familyRows } = await pool.query<{ family_id: string }>(
      'SELECT family_id FROM refresh_tokens WHERE token_hash = $1',
      [hashRefreshToken(session.refreshToken)],
    );
    const familyId = familyRows[0].family_id;
    const holder = await holdLeafRowLock(session);

    const rotating = fire(refresh(session));
    let revokingFamily: Promise<request.Response>;
    try {
      await waitForLockWaiters(pool, 1);
      revokingFamily = fire(
        request(app.getHttpServer()).delete(`/auth/sessions/${familyId}`).set(authHeader(session.accessToken)),
      );
      await waitForLockWaiters(pool, 2);
    } finally {
      await holder.query('COMMIT');
      holder.release();
    }

    const [rotateRes, revokeRes] = await Promise.all([rotating, revokingFamily]);

    expect(rotateRes.status).toBe(200);
    expect(revokeRes.status).toBe(204);

    const rows = await familyRowsOf(session);
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.every((row) => row.revoked_at !== null)).toBe(true);
    await refresh(sessionFrom(rotateRes)).expect(401);
  });
});
