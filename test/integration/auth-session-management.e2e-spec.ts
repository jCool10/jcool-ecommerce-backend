import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PG_POOL } from '../../src/shared/infrastructure/database/drizzle.tokens';
import { authHeader, loginAs, sessionHeaders } from '../setup/auth.helper';
import { createTestUser } from '../setup/fixtures/user.fixture';
import { resetDatabase } from '../setup/reset-database';
import { createTestApp } from '../setup/test-app.factory';

/**
 * The session-epoch bump (logout-all / change-password) rejects every outstanding access token at
 * once rather than leaving each alive until it expires.
 */
describe('Auth session management (integration, real Postgres + Redis)', () => {
  let app: INestApplication;
  let pool: Pool;

  const password = 'Password123!';
  const newPassword = 'NewPassword456!';

  beforeAll(async () => {
    app = await createTestApp();
    pool = app.get<Pool>(PG_POOL);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
  });

  describe('POST /auth/change-password', () => {
    it('swaps the credential: the new password logs in, the old one no longer does', async () => {
      const { user } = await createTestUser(app, { password });
      const session = await loginAs(app, { email: user.email, password });

      await request(app.getHttpServer())
        .post('/auth/change-password')
        .set(authHeader(session.accessToken))
        .send({ currentPassword: password, newPassword })
        .expect(204);

      await request(app.getHttpServer()).post('/auth/login').send({ email: user.email, password }).expect(401);
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: user.email, password: newPassword })
        .expect(200);
    });

    it('revokes every session: the caller’s access token and refresh cookie both stop working', async () => {
      const { user } = await createTestUser(app, { password });
      const session = await loginAs(app, { email: user.email, password });

      await request(app.getHttpServer()).get('/auth/me').set(authHeader(session.accessToken)).expect(200);

      await request(app.getHttpServer())
        .post('/auth/change-password')
        .set(authHeader(session.accessToken))
        .send({ currentPassword: password, newPassword })
        .expect(204);

      // Access token dies via the epoch bump; the refresh cookie can no longer rotate.
      await request(app.getHttpServer()).get('/auth/me').set(authHeader(session.accessToken)).expect(401);
      await request(app.getHttpServer()).post('/auth/refresh').set(sessionHeaders(session)).expect(401);
    });

    it('rejects a wrong current password (401) and leaves the credential unchanged', async () => {
      const { user } = await createTestUser(app, { password });
      const session = await loginAs(app, { email: user.email, password });

      await request(app.getHttpServer())
        .post('/auth/change-password')
        .set(authHeader(session.accessToken))
        .send({ currentPassword: 'not-my-password', newPassword })
        .expect(401);

      // Unchanged: the original password still authenticates.
      await request(app.getHttpServer()).post('/auth/login').send({ email: user.email, password }).expect(200);
    });

    it('rejects a too-short new password with 400 (DTO validation)', async () => {
      const { user } = await createTestUser(app, { password });
      const session = await loginAs(app, { email: user.email, password });

      await request(app.getHttpServer())
        .post('/auth/change-password')
        .set(authHeader(session.accessToken))
        .send({ currentPassword: password, newPassword: 'short' })
        .expect(400);
    });

    it('requires authentication (401 without a Bearer token)', async () => {
      await request(app.getHttpServer())
        .post('/auth/change-password')
        .send({ currentPassword: password, newPassword })
        .expect(401);
    });
  });

  describe('GET /auth/sessions + DELETE /auth/sessions/:id', () => {
    it('lists a user’s active sessions and flags the one making the request', async () => {
      const { user } = await createTestUser(app, { password });
      const a = await loginAs(app, { email: user.email, password });
      await loginAs(app, { email: user.email, password }); // a second device/session

      const res = await request(app.getHttpServer())
        .get('/auth/sessions')
        .set(authHeader(a.accessToken))
        .set(sessionHeaders(a))
        .expect(200);

      expect(res.body).toHaveLength(2);
      expect(res.body.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
      for (const s of res.body) {
        expect(s).toMatchObject({
          id: expect.any(String),
          createdAt: expect.any(String),
          expiresAt: expect.any(String),
          current: expect.any(Boolean),
        });
      }
    });

    it('revokes one remote session: that session can’t rotate, the caller’s still can', async () => {
      const { user } = await createTestUser(app, { password });
      const a = await loginAs(app, { email: user.email, password });
      const b = await loginAs(app, { email: user.email, password });

      const list = await request(app.getHttpServer())
        .get('/auth/sessions')
        .set(authHeader(a.accessToken))
        .set(sessionHeaders(a))
        .expect(200);
      const other = list.body.find((s: { current: boolean }) => !s.current) as { id: string };

      await request(app.getHttpServer())
        .delete(`/auth/sessions/${other.id}`)
        .set(authHeader(a.accessToken))
        .expect(204);

      // The revoked (B) session can no longer rotate; A's session is untouched.
      await request(app.getHttpServer()).post('/auth/refresh').set(sessionHeaders(b)).expect(401);
      await request(app.getHttpServer()).post('/auth/refresh').set(sessionHeaders(a)).expect(200);
    });

    it('404s revoking a session id that isn’t the caller’s (cross-user isolation)', async () => {
      const owner = await createTestUser(app, { password });
      const ownerSession = await loginAs(app, { email: owner.user.email, password });
      const ownerList = await request(app.getHttpServer())
        .get('/auth/sessions')
        .set(authHeader(ownerSession.accessToken))
        .expect(200);
      const foreignId = (ownerList.body[0] as { id: string }).id;

      const attacker = await createTestUser(app, { password });
      const attackerSession = await loginAs(app, { email: attacker.user.email, password });

      await request(app.getHttpServer())
        .delete(`/auth/sessions/${foreignId}`)
        .set(authHeader(attackerSession.accessToken))
        .expect(404);

      // The owner's session is still alive — nothing was revoked.
      await request(app.getHttpServer()).post('/auth/refresh').set(sessionHeaders(ownerSession)).expect(200);
    });

    it('404s an unknown session id and 400s a malformed one', async () => {
      const { user } = await createTestUser(app, { password });
      const a = await loginAs(app, { email: user.email, password });

      await request(app.getHttpServer())
        .delete(`/auth/sessions/${randomUUID()}`)
        .set(authHeader(a.accessToken))
        .expect(404);
      await request(app.getHttpServer()).delete('/auth/sessions/not-a-uuid').set(authHeader(a.accessToken)).expect(400);
    });

    it('requires authentication to list sessions (401)', async () => {
      await request(app.getHttpServer()).get('/auth/sessions').expect(401);
    });
  });

  describe('POST /auth/logout-all (session epoch)', () => {
    it('kills every session at once — all access tokens and refresh cookies stop working', async () => {
      const { user } = await createTestUser(app, { password });
      const a = await loginAs(app, { email: user.email, password });
      const b = await loginAs(app, { email: user.email, password });

      await request(app.getHttpServer()).get('/auth/me').set(authHeader(a.accessToken)).expect(200);
      await request(app.getHttpServer()).get('/auth/me').set(authHeader(b.accessToken)).expect(200);

      await request(app.getHttpServer()).post('/auth/logout-all').set(authHeader(a.accessToken)).expect(204);

      // Every outstanding access token is rejected by the epoch bump (not just A's).
      await request(app.getHttpServer()).get('/auth/me').set(authHeader(a.accessToken)).expect(401);
      await request(app.getHttpServer()).get('/auth/me').set(authHeader(b.accessToken)).expect(401);
      await request(app.getHttpServer()).post('/auth/refresh').set(sessionHeaders(a)).expect(401);
      await request(app.getHttpServer()).post('/auth/refresh').set(sessionHeaders(b)).expect(401);
    });

    it('lets the user log in again afterward (a fresh session under the new epoch works)', async () => {
      const { user } = await createTestUser(app, { password });
      const a = await loginAs(app, { email: user.email, password });

      await request(app.getHttpServer()).post('/auth/logout-all').set(authHeader(a.accessToken)).expect(204);

      const fresh = await loginAs(app, { email: user.email, password });
      await request(app.getHttpServer()).get('/auth/me').set(authHeader(fresh.accessToken)).expect(200);
    });

    it('requires authentication (401 without a Bearer token)', async () => {
      await request(app.getHttpServer()).post('/auth/logout-all').expect(401);
    });
  });
});
