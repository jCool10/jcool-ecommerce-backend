import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { authHeader } from '../setup/bearer.helper';
import { createTestPrincipal } from '../setup/fixtures/principal.fixture';
import { closeAppAfterAll } from '../setup/harness';
import { createTestApp } from '../setup/test-app.factory';

type Method = 'get' | 'post' | 'delete';

// Public, bearer-guarded and CSRF-guarded routes alike: the answer must not depend on which guard
// would have refused first.
const AUTH_ROUTES: [Method, string][] = [
  ['post', '/auth/login'],
  ['post', '/auth/register'],
  ['post', '/auth/refresh'],
  ['post', '/auth/logout'],
  ['get', '/auth/me'],
  ['delete', '/auth/sessions/0198f0d8-8888-7000-8000-000000000001'],
];

/** After the gateway sends /auth to the user-service, a client still calling the api is out of date. */
describe('Auth routes switched off (integration)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp({ AUTH_ROUTES_ENABLED: 'false' });
  });
  closeAppAfterAll(() => app);

  it.each(AUTH_ROUTES)('answers %s %s with 410', async (method, path) => {
    const res = await request(app.getHttpServer())[method](path).send({});

    expect(res.status).toBe(410);
    expect(res.body.message).toBe('Authentication has moved to the user service');
  });

  it('still authenticates every other route', async () => {
    const { accessToken } = await createTestPrincipal(app);

    await request(app.getHttpServer()).get('/cart').set(authHeader(accessToken)).expect(200);
  });
});
