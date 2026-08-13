import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CSRF_TOKEN_COOKIE,
  REFRESH_TOKEN_COOKIE,
} from '../../src/modules/user/interface/security/auth-cookie.constants';
import { PG_POOL } from '../../src/shared/infrastructure/database/drizzle.tokens';
import {
  authHeader,
  cookieValueOf,
  loginAs,
  sessionHeaders,
  setCookieEntry,
} from '../setup/auth.helper';
import { createTestUser } from '../setup/fixtures/user.fixture';
import { resetDatabase } from '../setup/reset-database';
import { createTestApp } from '../setup/test-app.factory';

// Black-box HTTP tests for the Auth context (register / login / refresh / guard /
// RBAC) over real Postgres + Redis. Locks the public contract so the inner layers
// can be refactored safely. Each `it` reads as one behavioural guarantee.
describe('Auth (integration, real Postgres + Redis)', () => {
  let app: INestApplication;
  let pool: Pool;

  const password = 'Password123!';

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

  describe('POST /auth/register', () => {
    it('creates an account (201) and never leaks passwordHash', async () => {
      const email = 'new-user@test.local';
      const res = await request(app.getHttpServer()).post('/auth/register').send({ email, password });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ email, role: 'CUSTOMER' });
      expect(res.body.id).toBeTruthy();
      expect(res.body).not.toHaveProperty('passwordHash');
      expect(res.body).not.toHaveProperty('password');
    });

    it('rejects a duplicate email with 409', async () => {
      const email = 'dupe@test.local';
      await request(app.getHttpServer()).post('/auth/register').send({ email, password }).expect(201);

      const res = await request(app.getHttpServer()).post('/auth/register').send({ email, password });
      expect(res.status).toBe(409);
    });

    it('rejects an invalid email with 400', async () => {
      const res = await request(app.getHttpServer()).post('/auth/register').send({ email: 'not-an-email', password });
      expect(res.status).toBe(400);
    });

    it('rejects a too-short password with 400', async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email: 'shortpw@test.local', password: 'short' });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /auth/login', () => {
    const email = 'login@test.local';

    beforeEach(async () => {
      await request(app.getHttpServer()).post('/auth/register').send({ email, password }).expect(201);
    });

    it('returns an access token in the body + refresh/csrf as cookies, usable on a protected route (200)', async () => {
      const res = await request(app.getHttpServer()).post('/auth/login').send({ email, password });

      expect(res.status).toBe(200);
      expect(res.body.accessToken.split('.')).toHaveLength(3); // header.payload.signature
      expect(res.body.expiresIn).toBeGreaterThan(0);

      // Refresh token is NOT in the body anymore — it's an httpOnly cookie.
      expect(res.body).not.toHaveProperty('refreshToken');
      const refreshCookie = setCookieEntry(res, REFRESH_TOKEN_COOKIE);
      expect(refreshCookie).toContain('HttpOnly');
      expect(refreshCookie).toContain('SameSite=Strict');
      expect(cookieValueOf(res, REFRESH_TOKEN_COOKIE)!.length).toBeGreaterThan(0);

      // The CSRF cookie is readable (no HttpOnly) so the client can echo it back.
      const csrfCookie = setCookieEntry(res, CSRF_TOKEN_COOKIE);
      expect(csrfCookie).toBeDefined();
      expect(csrfCookie).not.toContain('HttpOnly');

      // The login-issued access token authenticates a protected route end-to-end.
      const me = await request(app.getHttpServer()).get('/auth/me').set(authHeader(res.body.accessToken));
      expect(me.status).toBe(200);
      expect(me.body.email).toBe(email);
    });

    it('rejects a wrong password with 401', async () => {
      const res = await request(app.getHttpServer()).post('/auth/login').send({ email, password: 'WrongPassword9!' });
      expect(res.status).toBe(401);
    });

    it('rejects an unknown user with 401 (no user-existence disclosure)', async () => {
      const res = await request(app.getHttpServer()).post('/auth/login').send({ email: 'ghost@test.local', password });
      expect(res.status).toBe(401);
    });
  });

  describe('POST /auth/refresh (rotation + reuse detection)', () => {
    const email = 'refresh@test.local';

    beforeEach(async () => {
      await request(app.getHttpServer()).post('/auth/register').send({ email, password }).expect(201);
    });

    it('rotates the token pair on a valid refresh cookie (200, new refresh cookie issued)', async () => {
      const first = await loginAs(app, { email, password });

      const res = await request(app.getHttpServer()).post('/auth/refresh').set(sessionHeaders(first));

      expect(res.status).toBe(200);
      expect(res.body.accessToken.split('.')).toHaveLength(3);
      // A fresh refresh cookie is set, different from the one we presented.
      expect(cookieValueOf(res, REFRESH_TOKEN_COOKIE)).not.toBe(first.refreshToken);
    });

    it('rejects reuse of a rotated-away refresh cookie with 401', async () => {
      const first = await loginAs(app, { email, password });

      // Rotate once: `first`'s refresh cookie is now superseded.
      await request(app.getHttpServer()).post('/auth/refresh').set(sessionHeaders(first)).expect(200);

      // Replaying the old cookie is the stolen-token signature → 401.
      const reuse = await request(app.getHttpServer()).post('/auth/refresh').set(sessionHeaders(first));
      expect(reuse.status).toBe(401);
    });

    it('rejects a refresh with no cookie at all with 401', async () => {
      // No refresh cookie and no CSRF token → CSRF guard rejects first (403).
      const res = await request(app.getHttpServer()).post('/auth/refresh');
      expect(res.status).toBe(403);
    });
  });

  describe('POST /auth/refresh (CSRF double-submit)', () => {
    const email = 'csrf@test.local';

    beforeEach(async () => {
      await request(app.getHttpServer()).post('/auth/register').send({ email, password }).expect(201);
    });

    it('rejects refresh when the CSRF header is missing even though the cookie is present (403)', async () => {
      const session = await loginAs(app, { email, password });
      const cookie = session.setCookies.map((c) => c.split(';')[0].trim()).join('; ');

      // Cookies sent (incl. csrf_token) but no x-csrf-token header to match it.
      const res = await request(app.getHttpServer()).post('/auth/refresh').set('Cookie', cookie);
      expect(res.status).toBe(403);
    });

    it('rejects refresh when the CSRF header does not match the cookie (403)', async () => {
      const session = await loginAs(app, { email, password });

      const res = await request(app.getHttpServer())
        .post('/auth/refresh')
        .set(sessionHeaders(session))
        .set('x-csrf-token', 'forged.value');
      expect(res.status).toBe(403);
    });
  });

  describe('POST /auth/logout (immediate revocation)', () => {
    const email = 'logout@test.local';

    beforeEach(async () => {
      await request(app.getHttpServer()).post('/auth/register').send({ email, password }).expect(201);
    });

    it('revokes the access token immediately + clears the refresh cookie', async () => {
      const session = await loginAs(app, { email, password });

      // Sanity: the token works before logout.
      await request(app.getHttpServer()).get('/auth/me').set(authHeader(session.accessToken)).expect(200);

      const out = await request(app.getHttpServer())
        .post('/auth/logout')
        .set(authHeader(session.accessToken))
        .set(sessionHeaders(session))
        .expect(204);

      // The response clears the refresh cookie (expiry in the past).
      expect(setCookieEntry(out, REFRESH_TOKEN_COOKIE)).toContain('Expires=Thu, 01 Jan 1970');

      // The reported bug: this used to still return 200 until the token expired.
      const me = await request(app.getHttpServer()).get('/auth/me').set(authHeader(session.accessToken));
      expect(me.status).toBe(401);
    });

    it('revokes the refresh token — it can no longer rotate after logout (401)', async () => {
      const session = await loginAs(app, { email, password });

      await request(app.getHttpServer())
        .post('/auth/logout')
        .set(authHeader(session.accessToken))
        .set(sessionHeaders(session))
        .expect(204);

      // CSRF token still validates; the refresh token itself is revoked → 401.
      const res = await request(app.getHttpServer()).post('/auth/refresh').set(sessionHeaders(session));
      expect(res.status).toBe(401);
    });

    it('rejects a repeat logout with the now-revoked token (401 at the guard)', async () => {
      const session = await loginAs(app, { email, password });

      await request(app.getHttpServer())
        .post('/auth/logout')
        .set(authHeader(session.accessToken))
        .set(sessionHeaders(session))
        .expect(204);

      // The access token is denylisted, so the global JwtAuthGuard rejects the
      // second attempt (before the route's CsrfGuard). Revoke idempotency is unit-tested.
      const res = await request(app.getHttpServer())
        .post('/auth/logout')
        .set(authHeader(session.accessToken))
        .set(sessionHeaders(session));
      expect(res.status).toBe(401);
    });
  });

  describe('Route protection (JwtAuthGuard) and RBAC (RolesGuard)', () => {
    it('rejects a protected route without a token with 401', async () => {
      const res = await request(app.getHttpServer()).get('/auth/me');
      expect(res.status).toBe(401);
    });

    it('allows a protected route with a valid token (200)', async () => {
      const { user, accessToken } = await createTestUser(app);
      const res = await request(app.getHttpServer()).get('/auth/me').set(authHeader(accessToken));

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: user.id, email: user.email, role: user.role });
    });

    it('rejects an admin route for an authenticated non-admin with 403', async () => {
      const { accessToken } = await createTestUser(app); // default role CUSTOMER
      const res = await request(app.getHttpServer())
        .post('/admin/categories')
        .set(authHeader(accessToken))
        .send({ name: 'Blocked', slug: 'blocked' });

      expect(res.status).toBe(403);
    });

    it('rejects an admin route without a token with 401 (authenticate before authorize)', async () => {
      const res = await request(app.getHttpServer())
        .post('/admin/categories')
        .send({ name: 'Blocked', slug: 'blocked' });
      expect(res.status).toBe(401);
    });
  });
});
