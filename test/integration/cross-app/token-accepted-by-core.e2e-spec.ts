import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PG_POOL } from '@shared/infrastructure/database/drizzle.tokens';
import { authHeader, loginAs } from '../../setup/auth.helper';
import { createRealTestUser } from '../../setup/fixtures/user.fixture';
import { resetDatabase } from '../../setup/reset-database';
import { createTestApp, createUserApp } from '../../setup/test-app.factory';

const PASSWORD = 'Password123!';

/**
 * The entire interface between the two services: a signed token, and the Redis epoch behind it. Two
 * apps on two databases, wired to each other by nothing — no HTTP call, no queue, no shared module.
 * Both factories run side by side here precisely because a composite AppModule would prove the
 * opposite of what this file claims.
 */
describe('A token minted by user-service, spent on commerce-core (integration)', () => {
  let user: INestApplication;
  let core: INestApplication;
  let userPool: Pool;
  let corePool: Pool;

  beforeAll(async () => {
    user = await createUserApp();
    core = await createTestApp();
    userPool = user.get<Pool>(PG_POOL);
    corePool = core.get<Pool>(PG_POOL);
    await Promise.all([resetDatabase(userPool), resetDatabase(corePool)]);
  });

  afterAll(async () => {
    await resetDatabase(userPool);
    await core?.close();
    await user?.close();
  });

  // core holds only the public key: it has never seen this user's row, and cannot ask for it.
  it('accepts a token from an issuer whose database it cannot reach', async () => {
    const { accessToken } = await createRealTestUser(user, { emailVerified: true });

    const res = await request(core.getHttpServer()).get('/cart').set(authHeader(accessToken)).expect(200);

    expect(res.body.items).toEqual([]);
  });

  // Revocation is the one thing a locally verified token cannot express on its own, so it travels as
  // the epoch in Redis. No callback, no invalidation message — core reads the key on the next request.
  it('closes a core session on the next request after logout-all on user-service', async () => {
    const { user: account } = await createRealTestUser(user, { emailVerified: true });
    const session = await loginAs(user, { email: account.email, password: PASSWORD });
    await request(core.getHttpServer()).get('/cart').set(authHeader(session.accessToken)).expect(200);

    await request(user.getHttpServer()).post('/auth/logout-all').set(authHeader(session.accessToken)).expect(204);

    await request(core.getHttpServer()).get('/cart').set(authHeader(session.accessToken)).expect(401);
  });

  // The role travels in the token too, so core authorizes against a claim it never wrote.
  it('rejects an admin route for a non-admin token from the other service', async () => {
    const { accessToken } = await createRealTestUser(user, { emailVerified: true });

    await request(core.getHttpServer())
      .post('/admin/categories')
      .set(authHeader(accessToken))
      .send({ name: 'Blocked', slug: 'blocked' })
      .expect(403);
  });

  it('rejects an admin route without a token with 401 — authenticate before authorize', async () => {
    await request(core.getHttpServer())
      .post('/admin/categories')
      .send({ name: 'Blocked', slug: 'blocked' })
      .expect(401);
  });
});
