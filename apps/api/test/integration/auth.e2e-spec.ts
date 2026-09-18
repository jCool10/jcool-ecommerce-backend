import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  EMAIL_VERIFICATION_TOKEN_REPOSITORY,
  type EmailVerificationTokenRepositoryPort,
} from '../../src/modules/user/application/ports/email-verification-token-repository.port';
import {
  PASSWORD_RESET_TOKEN_REPOSITORY,
  type PasswordResetTokenRepositoryPort,
} from '../../src/modules/user/application/ports/password-reset-token-repository.port';
import { sha256Hex } from '../../src/modules/user/application/sha256-hex';
import {
  CSRF_TOKEN_COOKIE,
  REFRESH_TOKEN_COOKIE,
} from '../../src/modules/user/interface/security/auth-cookie.constants';
import { authHeader, cookieValueOf, loginAs, sessionHeaders, setCookieEntry } from '../setup/auth.helper';
import { createTestUser } from '../setup/fixtures/user.fixture';
import { closeAppAfterAll, createTestAppWithPool, resetDatabaseBeforeEach } from '../setup/harness';

describe('Auth (integration, real Postgres + Redis)', () => {
  let app: INestApplication;
  let pool: Pool;

  const password = 'Password123!';

  beforeAll(async () => {
    ({ app, pool } = await createTestAppWithPool());
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  describe('Security headers (helmet)', () => {
    it('rides hardening headers on every response and strips X-Powered-By', async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: 'nobody@test.local', password: 'whatever' });

      // The 401 body is irrelevant; helmet's headers are what we assert here.
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBeDefined();
      expect(res.headers['x-powered-by']).toBeUndefined();
    });
  });

  describe('POST /auth/register', () => {
    it('creates an unverified account (201) and never leaks passwordHash', async () => {
      const email = 'new-user@test.local';
      const res = await request(app.getHttpServer()).post('/auth/register').send({ email, password });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ email, role: 'CUSTOMER', emailVerified: false });
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

  describe('POST /auth/verify-email', () => {
    // The raw token is emailed, never returned by an endpoint — mint one directly
    // (only its hash is stored) and present the raw value to the API.
    async function issueToken(userId: string, expiresAt = new Date(Date.now() + 3_600_000)): Promise<string> {
      const raw = randomBytes(32).toString('base64url');
      const repo = app.get<EmailVerificationTokenRepositoryPort>(EMAIL_VERIFICATION_TOKEN_REPOSITORY);
      await repo.create({ userId, tokenHash: sha256Hex(raw), expiresAt });
      return raw;
    }

    it('verifies the email with a valid token (204) and flips emailVerified', async () => {
      const { user, accessToken } = await createTestUser(app);
      const token = await issueToken(user.id);

      await request(app.getHttpServer()).post('/auth/verify-email').send({ token }).expect(204);

      const me = await request(app.getHttpServer()).get('/auth/me').set(authHeader(accessToken)).expect(200);
      expect(me.body.emailVerified).toBe(true);
    });

    it('rejects a second use of the same token (single-use → 400)', async () => {
      const { user } = await createTestUser(app);
      const token = await issueToken(user.id);

      await request(app.getHttpServer()).post('/auth/verify-email').send({ token }).expect(204);
      const replay = await request(app.getHttpServer()).post('/auth/verify-email').send({ token });
      expect(replay.status).toBe(400);
    });

    it('rejects an expired token with 400', async () => {
      const { user } = await createTestUser(app);
      const token = await issueToken(user.id, new Date(Date.now() - 1_000));

      const res = await request(app.getHttpServer()).post('/auth/verify-email').send({ token });
      expect(res.status).toBe(400);
    });

    it('rejects an unknown token with 400', async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/verify-email')
        .send({ token: randomBytes(32).toString('base64url') });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /auth/resend-verification', () => {
    it('returns the same generic 202 for unknown, unverified, and already-verified addresses', async () => {
      const { user } = await createTestUser(app);
      const verified = await createTestUser(app, { emailVerified: true });

      const unknown = await request(app.getHttpServer())
        .post('/auth/resend-verification')
        .send({ email: 'nobody@test.local' });
      const unverified = await request(app.getHttpServer())
        .post('/auth/resend-verification')
        .send({ email: user.email });
      const already = await request(app.getHttpServer())
        .post('/auth/resend-verification')
        .send({ email: verified.user.email });

      expect(unknown.status).toBe(202);
      expect(unverified.status).toBe(202);
      expect(already.status).toBe(202);
    });

    it('rejects a malformed email with 400', async () => {
      const res = await request(app.getHttpServer()).post('/auth/resend-verification').send({ email: 'not-an-email' });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /auth/forgot-password', () => {
    it('returns the same generic 202 for both a known and an unknown address', async () => {
      const { user } = await createTestUser(app);

      const known = await request(app.getHttpServer()).post('/auth/forgot-password').send({ email: user.email });
      const unknown = await request(app.getHttpServer())
        .post('/auth/forgot-password')
        .send({ email: 'nobody@test.local' });

      expect(known.status).toBe(202);
      expect(unknown.status).toBe(202);
    });

    it('rejects a malformed email with 400', async () => {
      const res = await request(app.getHttpServer()).post('/auth/forgot-password').send({ email: 'not-an-email' });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /auth/reset-password', () => {
    const newPassword = 'NewPassword456!';

    async function issueResetToken(userId: string, expiresAt = new Date(Date.now() + 3_600_000)): Promise<string> {
      const raw = randomBytes(32).toString('base64url');
      const repo = app.get<PasswordResetTokenRepositoryPort>(PASSWORD_RESET_TOKEN_REPOSITORY);
      await repo.create({ userId, tokenHash: sha256Hex(raw), expiresAt });
      return raw;
    }

    it('resets the password (204): new password logs in, old one is rejected', async () => {
      const { user, password } = await createTestUser(app);
      const token = await issueResetToken(user.id);

      await request(app.getHttpServer())
        .post('/auth/reset-password')
        .send({ token, password: newPassword })
        .expect(204);

      const withNew = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: user.email, password: newPassword });
      expect(withNew.status).toBe(200);

      const withOld = await request(app.getHttpServer()).post('/auth/login').send({ email: user.email, password });
      expect(withOld.status).toBe(401);
    });

    it('revokes all existing sessions — the pre-reset access token and refresh cookie both stop working', async () => {
      const { user, password } = await createTestUser(app);
      const session = await loginAs(app, { email: user.email, password });
      const token = await issueResetToken(user.id);

      await request(app.getHttpServer()).get('/auth/me').set(authHeader(session.accessToken)).expect(200);

      await request(app.getHttpServer())
        .post('/auth/reset-password')
        .send({ token, password: newPassword })
        .expect(204);

      // The session predates the reset: its access token dies via the epoch bump and its refresh can't rotate.
      await request(app.getHttpServer()).get('/auth/me').set(authHeader(session.accessToken)).expect(401);
      const rotate = await request(app.getHttpServer()).post('/auth/refresh').set(sessionHeaders(session));
      expect(rotate.status).toBe(401);
    });

    it('rejects a second use of the same token (single-use → 400)', async () => {
      const { user } = await createTestUser(app);
      const token = await issueResetToken(user.id);

      await request(app.getHttpServer())
        .post('/auth/reset-password')
        .send({ token, password: newPassword })
        .expect(204);
      const replay = await request(app.getHttpServer())
        .post('/auth/reset-password')
        .send({ token, password: 'AnotherPass789!' });
      expect(replay.status).toBe(400);
    });

    it('rejects an expired token with 400', async () => {
      const { user } = await createTestUser(app);
      const token = await issueResetToken(user.id, new Date(Date.now() - 1_000));

      const res = await request(app.getHttpServer())
        .post('/auth/reset-password')
        .send({ token, password: newPassword });
      expect(res.status).toBe(400);
    });

    it('rejects an unknown token with 400', async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/reset-password')
        .send({ token: randomBytes(32).toString('base64url'), password: newPassword });
      expect(res.status).toBe(400);
    });

    it('rejects a too-short new password with 400', async () => {
      const { user } = await createTestUser(app);
      const token = await issueResetToken(user.id);

      const res = await request(app.getHttpServer()).post('/auth/reset-password').send({ token, password: 'short' });
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

      // The refresh token is not in the body — it travels as an httpOnly cookie.
      expect(res.body).not.toHaveProperty('refreshToken');
      const refreshCookie = setCookieEntry(res, REFRESH_TOKEN_COOKIE);
      expect(refreshCookie).toContain('HttpOnly');
      expect(refreshCookie).toContain('SameSite=Strict');
      expect(cookieValueOf(res, REFRESH_TOKEN_COOKIE)!.length).toBeGreaterThan(0);

      // The CSRF cookie is readable (no HttpOnly) so the client can echo it back.
      const csrfCookie = setCookieEntry(res, CSRF_TOKEN_COOKIE);
      expect(csrfCookie).toBeDefined();
      expect(csrfCookie).not.toContain('HttpOnly');

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
      expect(cookieValueOf(res, REFRESH_TOKEN_COOKIE)).not.toBe(first.refreshToken);
    });

    it('rejects reuse of a rotated-away refresh cookie with 401', async () => {
      const first = await loginAs(app, { email, password });

      await request(app.getHttpServer()).post('/auth/refresh').set(sessionHeaders(first)).expect(200);

      // Replaying the old cookie is the stolen-token signature → 401.
      const reuse = await request(app.getHttpServer()).post('/auth/refresh').set(sessionHeaders(first));
      expect(reuse.status).toBe(401);
    });

    it('reuse detection also kills the rotated-out access token (epoch bump, not just the family)', async () => {
      const first = await loginAs(app, { email, password });

      const rotated = await request(app.getHttpServer()).post('/auth/refresh').set(sessionHeaders(first)).expect(200);
      const successorAccess = rotated.body.accessToken as string;
      await request(app.getHttpServer()).get('/auth/me').set(authHeader(successorAccess)).expect(200);

      // Replay the superseded cookie → reuse detected: family revoked AND epoch bumped.
      await request(app.getHttpServer()).post('/auth/refresh').set(sessionHeaders(first)).expect(401);

      // The successor access token is now rejected immediately, not left alive for its TTL.
      await request(app.getHttpServer()).get('/auth/me').set(authHeader(successorAccess)).expect(401);
    });

    it('rejects a refresh with no cookie at all with 403', async () => {
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

      await request(app.getHttpServer()).get('/auth/me').set(authHeader(session.accessToken)).expect(200);

      const out = await request(app.getHttpServer())
        .post('/auth/logout')
        .set(authHeader(session.accessToken))
        .set(sessionHeaders(session))
        .expect(204);

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
      const { accessToken } = await createTestUser(app);
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
