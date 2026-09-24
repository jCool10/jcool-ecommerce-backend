import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { SignJWT } from 'jose';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { authHeader } from '../setup/bearer.helper';
import { createTestPrincipal } from '../setup/fixtures/principal.fixture';
import { closeAppAfterAll } from '../setup/harness';
import { createTestApp } from '../setup/test-app.factory';

type Method = 'get' | 'post' | 'delete';

const AUTH_ROUTES: [Method, string][] = [
  ['post', '/auth/login'],
  ['post', '/auth/register'],
  ['post', '/auth/refresh'],
  ['post', '/auth/logout'],
  ['get', '/auth/me'],
  ['delete', '/auth/sessions/0198f0d8-8888-7000-8000-000000000001'],
];

function hs256(secret: string): Promise<string> {
  return new SignJWT({ sub: '0198f0d8-9999-8000-8000-000000000001', role: 'CUSTOMER', jti: 'jti-1', epoch: 0 })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(secret));
}

/** The api after the user context left it: ES256 from the user-service, and nothing else. */
describe('The api without its own auth (integration)', () => {
  let app: INestApplication;

  const cart = (token: string) => request(app.getHttpServer()).get('/cart').set(authHeader(token));

  beforeAll(async () => {
    app = await createTestApp();
  });
  closeAppAfterAll(() => app);

  it('accepts an ES256 token from the user-service', async () => {
    const { accessToken } = await createTestPrincipal(app);

    expect((await cart(accessToken)).status).toBe(200);
  });

  it('refuses an HS256 token whatever it is signed with', async () => {
    expect((await cart(await hs256(randomBytes(32).toString('hex')))).status).toBe(401);
  });

  it('serves none of the auth routes it used to own', async () => {
    const answers: string[] = [];
    for (const [method, path] of AUTH_ROUTES) {
      const res = await request(app.getHttpServer())[method](path).send({});
      answers.push(`${method} ${path} ${res.status}`);
    }

    expect(answers).toEqual(AUTH_ROUTES.map(([method, path]) => `${method} ${path} 404`));
  });
});
