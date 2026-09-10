import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PG_POOL } from '@shared/infrastructure/database/drizzle.tokens';
import { createRealTestUser } from '../setup/fixtures/user.fixture';
import { resetDatabase } from '../setup/reset-database';
import { createUserApp } from '../setup/test-app.factory';

// The verified-email login gate is off in the default harness, so this suite opts in explicitly
// and boots its own app with AUTH_REQUIRE_VERIFIED_EMAIL='true'.
describe('Auth verified-email login gate (integration)', () => {
  let app: INestApplication;
  let pool: Pool;

  const password = 'Password123!';

  beforeAll(async () => {
    process.env.AUTH_REQUIRE_VERIFIED_EMAIL = 'true';
    app = await createUserApp();
    pool = app.get<Pool>(PG_POOL);
  });

  afterAll(async () => {
    await app.close();
    // Don't leak the flag into other e2e suites sharing this worker's env.
    delete process.env.AUTH_REQUIRE_VERIFIED_EMAIL;
  });

  beforeEach(async () => {
    await resetDatabase(pool);
  });

  it('refuses login for an unverified account with 403 (credentials are correct)', async () => {
    const { user } = await createRealTestUser(app, { password }); // unverified

    const res = await request(app.getHttpServer()).post('/auth/login').send({ email: user.email, password });
    expect(res.status).toBe(403);
  });

  it('allows login once the account is verified (200)', async () => {
    const { user } = await createRealTestUser(app, { password, emailVerified: true });

    const res = await request(app.getHttpServer()).post('/auth/login').send({ email: user.email, password });
    expect(res.status).toBe(200);
    expect(res.body.accessToken.split('.')).toHaveLength(3);
  });

  it('still returns the generic 401 (not 403) for a wrong password on an unverified account', async () => {
    const { user } = await createRealTestUser(app, { password }); // unverified

    // The gate runs only after credentials pass, so a bad password must not leak
    // that the account merely needs verification.
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: user.email, password: 'WrongPassword9!' });
    expect(res.status).toBe(401);
  });
});
