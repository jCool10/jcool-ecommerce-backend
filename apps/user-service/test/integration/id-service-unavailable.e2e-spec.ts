import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ID_GENERATOR } from '../../src/modules/user/application/ports/id-generator.port';
import { IdServiceHttpAdapter } from '../../src/modules/user/infrastructure/id-service.http-adapter';
import { loginAs, sessionFrom, sessionHeaders } from '../setup/auth.helper';
import { createTestUser } from '../setup/fixtures/user.fixture';
import { createTestAppWithPool, resetDatabaseBeforeEach } from '../setup/harness';
import { createTestApp } from '../setup/test-app.factory';

/**
 * Two apps on one database: `seeder` mints in process to set the scene, `app` runs the shipped
 * adapter against a port nothing listens on.
 */
describe('Id service unavailable (integration)', () => {
  let seeder: INestApplication;
  let app: INestApplication;
  let pool: Pool;

  const password = 'Password123!';

  beforeAll(async () => {
    ({ app: seeder, pool } = await createTestAppWithPool());
    app = await createTestApp({ ID_SERVICE_TIMEOUT_MS: '500' }, [], { realIdService: true });
  });

  afterAll(async () => {
    await app?.close();
    await seeder?.close();
  });

  resetDatabaseBeforeEach(() => pool);

  const refreshTokensOf = async (userId: string) =>
    (
      await pool.query<{ revoked_at: Date | null; replaced_by_token_id: string | null }>(
        `SELECT revoked_at, replaced_by_token_id FROM refresh_tokens WHERE user_id = $1`,
        [userId],
      )
    ).rows;

  it('runs on the shipped id-service adapter', () => {
    expect(app.get(ID_GENERATOR)).toBeInstanceOf(IdServiceHttpAdapter);
  });

  it('answers register with 503 and writes no user', async () => {
    const email = 'no-ids@test.local';

    await request(app.getHttpServer()).post('/auth/register').send({ email, password }).expect(503);

    const { rows } = await pool.query(`SELECT 1 FROM users WHERE email = $1`, [email]);
    expect(rows).toHaveLength(0);
  });

  it('answers login with 503 and writes no refresh token', async () => {
    const { user } = await createTestUser(seeder, { password });

    await request(app.getHttpServer()).post('/auth/login').send({ email: user.email, password }).expect(503);

    expect(await refreshTokensOf(user.id)).toHaveLength(0);
  });

  it('answers refresh with 503 and leaves the presented token live', async () => {
    const { user } = await createTestUser(seeder, { password });
    const session = await loginAs(seeder, { email: user.email, password });

    await request(app.getHttpServer()).post('/auth/refresh').set(sessionHeaders(session)).expect(503);

    expect(await refreshTokensOf(user.id)).toEqual([{ revoked_at: null, replaced_by_token_id: null }]);
    // Not consumed: the same cookie still rotates once ids are back.
    await request(seeder.getHttpServer()).post('/auth/refresh').set(sessionHeaders(session)).expect(200);
  });

  // Only a known address reaches the mint, so any other answer would say which addresses have accounts.
  it.each(['/auth/forgot-password', '/auth/resend-verification'])(
    'answers %s for a known address with the same 202',
    async (path) => {
      const { user } = await createTestUser(seeder, { password });

      await request(app.getHttpServer()).post(path).send({ email: user.email }).expect(202);
    },
  );

  // A retired token never reaches the mint, so theft detection does not wait on the id service.
  it('still revokes the whole family on reuse of a retired token (401)', async () => {
    const { user } = await createTestUser(seeder, { password });
    const first = await loginAs(seeder, { email: user.email, password });
    const rotated = await request(seeder.getHttpServer()).post('/auth/refresh').set(sessionHeaders(first)).expect(200);

    await request(app.getHttpServer()).post('/auth/refresh').set(sessionHeaders(first)).expect(401);

    const family = await refreshTokensOf(user.id);
    expect(family).toHaveLength(2);
    expect(family.every((token) => token.revoked_at !== null)).toBe(true);
    // The successor went down with it.
    await request(seeder.getHttpServer())
      .post('/auth/refresh')
      .set(sessionHeaders(sessionFrom(rotated)))
      .expect(401);
  });
});
