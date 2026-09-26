import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CSRF_HEADER, REFRESH_TOKEN_COOKIE } from '../../src/modules/user/interface/security/auth-cookie.constants';
import { authHeader, loginAs, type Session } from '../setup/auth.helper';
import { closeAppAfterAll, createTestAppWithPool, resetDatabaseBeforeEach } from '../setup/harness';

/**
 * cookie-parser JSON-decodes any cookie value prefixed `j:`, so `refresh_token=j:{}` — trivial for a
 * client to send, forged or not — arrives at every reader as an object rather than a string. Every
 * route that reads the refresh cookie must answer as it would to a missing one, not throw.
 */
describe('A j:-prefixed refresh_token cookie (integration, real Postgres)', () => {
  let app: INestApplication;
  let pool: Pool;

  const email = 'malformed-cookie@test.local';
  const password = 'Password123!';

  beforeAll(async () => {
    ({ app, pool } = await createTestAppWithPool());
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  beforeEach(async () => {
    await request(app.getHttpServer()).post('/auth/register').send({ email, password }).expect(201);
  });

  // Keeps every other cookie (the CSRF pair) and only swaps the refresh token for a JSON-decoded one.
  function cookieHeaderWithJsonRefreshToken(session: Session): string {
    const kept = session.setCookies
      .map((c) => c.split(';')[0].trim())
      .filter((pair) => !pair.startsWith(`${REFRESH_TOKEN_COOKIE}=`));
    return [...kept, `${REFRESH_TOKEN_COOKIE}=j:{}`].join('; ');
  }

  it('answers /auth/refresh 401 — the same as a missing cookie — instead of 500', async () => {
    const session = await loginAs(app, { email, password });

    const res = await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Cookie', cookieHeaderWithJsonRefreshToken(session))
      .set(CSRF_HEADER, session.csrfToken);

    expect(res.status).toBe(401);
  });

  it('answers /auth/sessions 200 with the session list, treating the cookie as absent', async () => {
    const session = await loginAs(app, { email, password });

    const res = await request(app.getHttpServer())
      .get('/auth/sessions')
      .set(authHeader(session.accessToken))
      .set('Cookie', cookieHeaderWithJsonRefreshToken(session));

    expect(res.status).toBe(200);
    expect(res.body).toEqual([expect.objectContaining({ current: false })]);
  });

  it('answers /auth/logout 204 without orphaning the denylist write', async () => {
    const session = await loginAs(app, { email, password });

    const res = await request(app.getHttpServer())
      .post('/auth/logout')
      .set(authHeader(session.accessToken))
      .set('Cookie', cookieHeaderWithJsonRefreshToken(session))
      .set(CSRF_HEADER, session.csrfToken);

    expect(res.status).toBe(204);
    // The access token is still denylisted even though the (absent) refresh cookie had nothing to revoke.
    const me = await request(app.getHttpServer()).get('/auth/me').set(authHeader(session.accessToken));
    expect(me.status).toBe(401);
  });
});
