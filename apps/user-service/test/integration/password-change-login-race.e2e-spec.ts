import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  PASSWORD_RESET_TOKEN_REPOSITORY,
  type PasswordResetTokenRepositoryPort,
} from '../../src/modules/user/application/ports/password-reset-token-repository.port';
import { sha256Hex } from '../../src/modules/user/application/sha256-hex';
import { authHeader, loginAs, sessionFrom, sessionHeaders, type Session } from '../setup/auth.helper';
import { closeAppAfterAll, createTestAppWithPool, resetDatabaseBeforeEach } from '../setup/harness';
import { waitForLockWaiters } from '../setup/lock-waiters.helper';

/**
 * A login reads the user and verifies the password before it stores its refresh family, so a password
 * change can commit in between. A holder connection parks the change on the `users` row lock (or the
 * login on its foreign-key check) to fix which side reaches the user lock first.
 */
describe('A login races a password change or reset (integration, real Postgres)', () => {
  let app: INestApplication;
  let pool: Pool;
  let userId: string;

  const email = 'password-race@test.local';
  const oldPassword = 'Password123!';
  const newPassword = 'NewPassword456!';

  beforeAll(async () => {
    ({ app, pool } = await createTestAppWithPool());
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  beforeEach(async () => {
    await request(app.getHttpServer()).post('/auth/register').send({ email, password: oldPassword }).expect(201);
    const { rows } = await pool.query<{ id: string }>('SELECT id::text AS id FROM users WHERE email = $1', [email]);
    userId = rows[0].id;
  });

  // supertest sends only once something subscribes, so subscribe now and race the settled promise later.
  const fire = (req: request.Test): Promise<request.Response> => req.then((res) => res);

  const login = (password: string) => request(app.getHttpServer()).post('/auth/login').send({ email, password });

  const changePassword = (session: Session, to = newPassword) =>
    request(app.getHttpServer())
      .post('/auth/change-password')
      .set(authHeader(session.accessToken))
      .send({ currentPassword: oldPassword, newPassword: to });

  async function issueResetToken(): Promise<string> {
    const raw = randomBytes(32).toString('base64url');
    const tokens = app.get<PasswordResetTokenRepositoryPort>(PASSWORD_RESET_TOKEN_REPOSITORY);
    await tokens.create({ userId, tokenHash: sha256Hex(raw), expiresAt: new Date(Date.now() + 3_600_000) });
    return raw;
  }

  const resetPassword = (token: string) =>
    request(app.getHttpServer()).post('/auth/reset-password').send({ token, password: newPassword });

  // FOR NO KEY UPDATE blocks the change's UPDATE of the users row but not the FOR KEY SHARE a refresh-token
  // insert's foreign-key check takes; FOR UPDATE blocks both.
  async function holdUserRow(mode: 'FOR NO KEY UPDATE' | 'FOR UPDATE'): Promise<PoolClient> {
    const holder = await pool.connect();
    await holder.query('BEGIN');
    await holder.query(`SELECT 1 FROM users WHERE id = $1::bigint ${mode}`, [userId]);
    return holder;
  }

  async function liveRefreshTokens(): Promise<number> {
    const { rows } = await pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM refresh_tokens WHERE user_id = $1::bigint AND revoked_at IS NULL',
      [userId],
    );
    return Number(rows[0].n);
  }

  async function expectOnlyTheNewPasswordWorks(): Promise<void> {
    await login(oldPassword).expect(401);
    await login(newPassword).expect(200);
  }

  async function raceLoginAgainstAParkedReplacement(replacement: request.Test) {
    const holder = await holdUserRow('FOR NO KEY UPDATE');
    let replacing: Promise<request.Response>;
    let loggingIn: Promise<request.Response>;
    let loginParked: boolean;
    try {
      replacing = fire(replacement);
      await waitForLockWaiters(pool, 1); // the replacement is parked on the users row
      loggingIn = fire(login(oldPassword));
      // A login that stores its family without waiting on the user lock settles first instead.
      loginParked = await Promise.race([
        loggingIn.then(() => false),
        waitForLockWaiters(pool, 2).then(
          () => true,
          () => false,
        ),
      ]);
    } finally {
      await holder.query('COMMIT');
      holder.release();
    }
    // Otherwise the login verified after the replacement committed, and the case proves nothing.
    expect(loginParked).toBe(true);
    return Promise.all([replacing, loggingIn]);
  }

  it('a login that verified the old password while a password change commits leaves no live session', async () => {
    const session = await loginAs(app, { email, password: oldPassword });

    const [changeRes, loginRes] = await raceLoginAgainstAParkedReplacement(changePassword(session));

    expect(changeRes.status).toBe(204);
    expect(await liveRefreshTokens()).toBe(0);
    expect(loginRes.status).toBe(401);
    await expectOnlyTheNewPasswordWorks();
  });

  it('a login that verified the old password while a password reset commits leaves no live session', async () => {
    const token = await issueResetToken();

    const [resetRes, loginRes] = await raceLoginAgainstAParkedReplacement(resetPassword(token));

    expect(resetRes.status).toBe(204);
    expect(await liveRefreshTokens()).toBe(0);
    expect(loginRes.status).toBe(401);
    await expectOnlyTheNewPasswordWorks();
  });

  it('a login that stores its session before a password change commits loses it to the change', async () => {
    const session = await loginAs(app, { email, password: oldPassword });
    const holder = await holdUserRow('FOR UPDATE');
    let loggingIn: Promise<request.Response>;
    let changing: Promise<request.Response>;
    try {
      loggingIn = fire(login(oldPassword));
      await waitForLockWaiters(pool, 1); // the login's insert is parked on its foreign-key check
      changing = fire(changePassword(session));
      await waitForLockWaiters(pool, 2);
    } finally {
      await holder.query('COMMIT');
      holder.release();
    }

    const [loginRes, changeRes] = await Promise.all([loggingIn, changing]);

    expect(loginRes.status).toBe(200);
    expect(changeRes.status).toBe(204);
    expect(await liveRefreshTokens()).toBe(0);
    const raced = sessionFrom(loginRes);
    await request(app.getHttpServer()).post('/auth/refresh').set(sessionHeaders(raced)).expect(401);
    await request(app.getHttpServer()).get('/auth/me').set(authHeader(raced.accessToken)).expect(401);
    await expectOnlyTheNewPasswordWorks();
  });

  // The holder of a stolen session and the old password must not undo the owner's reset.
  it('a password change that verified the old password while a reset commits is refused', async () => {
    const intruderPassword = 'IntruderPassword789!';
    const intruder = await loginAs(app, { email, password: oldPassword });
    const token = await issueResetToken();
    const holder = await holdUserRow('FOR NO KEY UPDATE');
    let resetting: Promise<request.Response>;
    let changing: Promise<request.Response>;
    try {
      resetting = fire(resetPassword(token));
      await waitForLockWaiters(pool, 1); // the reset holds the user lock, parked on the users row
      changing = fire(changePassword(intruder, intruderPassword));
      await waitForLockWaiters(pool, 2); // the change verified the old hash and waits on the user lock
    } finally {
      await holder.query('COMMIT');
      holder.release();
    }

    const [resetRes, changeRes] = await Promise.all([resetting, changing]);

    expect(resetRes.status).toBe(204);
    expect(changeRes.status).toBe(401);
    await login(intruderPassword).expect(401);
    await expectOnlyTheNewPasswordWorks();
  });
});
