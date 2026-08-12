import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PG_POOL } from '../../src/shared/infrastructure/database/drizzle.tokens';
import { authHeader, loginAs } from '../setup/auth.helper';
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

    it('returns a token pair on correct credentials, usable on a protected route (200)', async () => {
      const res = await request(app.getHttpServer()).post('/auth/login').send({ email, password });

      expect(res.status).toBe(200);
      expect(res.body.accessToken.split('.')).toHaveLength(3); // header.payload.signature
      expect(typeof res.body.refreshToken).toBe('string');
      expect(res.body.refreshToken.length).toBeGreaterThan(0);
      expect(res.body.expiresIn).toBeGreaterThan(0);

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

    it('rotates the token pair on a valid refresh token (200, new token issued)', async () => {
      const first = await loginAs(app, { email, password });

      const res = await request(app.getHttpServer()).post('/auth/refresh').send({ refreshToken: first.refreshToken });

      expect(res.status).toBe(200);
      expect(res.body.refreshToken).not.toBe(first.refreshToken); // rotated
      expect(res.body.accessToken.split('.')).toHaveLength(3);
    });

    it('rejects reuse of a rotated-away refresh token with 401', async () => {
      const first = await loginAs(app, { email, password });

      // Rotate once: `first.refreshToken` is now superseded.
      await request(app.getHttpServer()).post('/auth/refresh').send({ refreshToken: first.refreshToken }).expect(200);

      // Replaying the old token is the stolen-token signature → 401.
      const reuse = await request(app.getHttpServer()).post('/auth/refresh').send({ refreshToken: first.refreshToken });
      expect(reuse.status).toBe(401);
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
