import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createTestUser } from '../setup/fixtures/user.fixture';
import { closeAppAfterAll, createTestAppWithPool, resetDatabaseBeforeEach } from '../setup/harness';

describe('Auth verified-email login gate (integration)', () => {
  let app: INestApplication;
  let pool: Pool;

  const password = 'Password123!';

  beforeAll(async () => {
    ({ app, pool } = await createTestAppWithPool({ AUTH_REQUIRE_VERIFIED_EMAIL: 'true' }));
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  it('refuses login for an unverified account with 403 (credentials are correct)', async () => {
    const { user } = await createTestUser(app, { password });

    const res = await request(app.getHttpServer()).post('/auth/login').send({ email: user.email, password });
    expect(res.status).toBe(403);
  });

  it('allows login once the account is verified (200)', async () => {
    const { user } = await createTestUser(app, { password, emailVerified: true });

    const res = await request(app.getHttpServer()).post('/auth/login').send({ email: user.email, password });
    expect(res.status).toBe(200);
    expect(res.body.accessToken.split('.')).toHaveLength(3);
  });

  it('still returns the generic 401 (not 403) for a wrong password on an unverified account', async () => {
    const { user } = await createTestUser(app, { password });

    // The gate runs after the credential check, so a bad password must not reveal it exists.
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: user.email, password: 'WrongPassword9!' });
    expect(res.status).toBe(401);
  });
});
