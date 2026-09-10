import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SessionService } from '@user/modules/user/application/services/session.service';
import { authEpochKey } from '@shared/auth';
import { PG_POOL } from '@shared/infrastructure/database/drizzle.tokens';
import { RedisService } from '@shared/infrastructure/redis';
import { authHeader, loginAs, sessionHeaders } from '../setup/auth.helper';
import { resetDatabase } from '../setup/reset-database';
import { createUserApp } from '../setup/test-app.factory';

/**
 * `users.token_epoch` is the source of truth; `auth:epoch:{sub}` is the copy every authenticated
 * request reads. Each path that mints or bumps must leave the two agreeing, because the verifier
 * never consults Postgres to find out.
 */
describe('Session-epoch projection (integration, real Postgres + Redis)', () => {
  let app: INestApplication;
  let pool: Pool;

  const password = 'Password123!';
  const newPassword = 'NewPassword456!';

  beforeAll(async () => {
    app = await createUserApp();
    pool = app.get<Pool>(PG_POOL);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
  });

  async function register(): Promise<{ id: string; email: string }> {
    const email = `epoch-${randomUUID()}@test.local`;
    const res = await request(app.getHttpServer()).post('/auth/register').send({ email, password }).expect(201);
    return { id: res.body.id as string, email };
  }

  async function storedEpoch(userId: string): Promise<number | null> {
    const { rows } = await pool.query<{ token_epoch: number }>('SELECT token_epoch FROM users WHERE id = $1', [userId]);
    return rows[0]?.token_epoch ?? null;
  }

  function projectedEpoch(userId: string): Promise<string | null> {
    return app.get(RedisService).getClient().get(authEpochKey(userId));
  }

  async function expectAgreement(userId: string): Promise<number> {
    const stored = await storedEpoch(userId);
    expect(String(stored)).toBe(await projectedEpoch(userId));
    return stored as number;
  }

  it('publishes nothing at registration — no token exists yet to fail closed on', async () => {
    const { id } = await register();

    expect(await storedEpoch(id)).toBe(0);
    expect(await projectedEpoch(id)).toBeNull();
  });

  it('publishes the stored epoch on login', async () => {
    const { id, email } = await register();

    await loginAs(app, { email, password });

    expect(await expectAgreement(id)).toBe(0);
  });

  it('republishes on refresh, so a rotated token never outlives its projection', async () => {
    const { id, email } = await register();
    const session = await loginAs(app, { email, password });
    await app.get(RedisService).getClient().del(authEpochKey(id));

    await request(app.getHttpServer()).post('/auth/refresh').set(sessionHeaders(session)).expect(200);

    await expectAgreement(id);
  });

  it('moves both sides together on logout-all', async () => {
    const { id, email } = await register();
    const session = await loginAs(app, { email, password });

    await request(app.getHttpServer()).post('/auth/logout-all').set(authHeader(session.accessToken)).expect(204);

    expect(await expectAgreement(id)).toBe(1);
  });

  it('moves both sides together on change-password', async () => {
    const { id, email } = await register();
    const session = await loginAs(app, { email, password });

    await request(app.getHttpServer())
      .post('/auth/change-password')
      .set(authHeader(session.accessToken))
      .send({ currentPassword: password, newPassword })
      .expect(204);

    expect(await expectAgreement(id)).toBe(1);
  });

  // A bump that updates no row means the user is gone. Publishing the 0 it returns would hand that
  // user's outstanding tokens a valid epoch, so the key is dropped and the verifier fails closed.
  it('deletes the projection instead of writing 0 when the user no longer exists', async () => {
    const missing = randomUUID();
    await app.get(RedisService).getClient().set(authEpochKey(missing), '3');

    await app.get(SessionService).revokeAccessTokens(missing);

    expect(await projectedEpoch(missing)).toBeNull();
  });
});
