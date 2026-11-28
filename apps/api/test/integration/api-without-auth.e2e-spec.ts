import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { SignJWT } from 'jose';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createAdminProbe } from '../setup/admin-probe.helper';
import { createTestAdminPrincipal } from '../setup/fixtures/principal.fixture';
import { closeAppAfterAll } from '../setup/harness';
import { createTestApp } from '../setup/test-app.factory';

type Method = 'get' | 'post' | 'patch' | 'delete';

const AUTH_ROUTES: [Method, string][] = [
  ['post', '/auth/login'],
  ['post', '/auth/register'],
  ['post', '/auth/refresh'],
  ['post', '/auth/logout'],
  ['get', '/auth/me'],
  ['delete', '/auth/sessions/0198f0d8-8888-7000-8000-000000000001'],
];

// The cart is the order-service's, and nothing calls the api service to service.
const RETIRED_ROUTES: [Method, string][] = [
  ['get', '/cart'],
  ['post', '/cart/items'],
  ['patch', '/cart/items/1'],
  ['delete', '/cart/items/1'],
  ['delete', '/cart'],
  ['get', '/internal/v1/carts/1/lines'],
  ['post', '/internal/v1/catalog/sku-views'],
];

function hs256(secret: string): Promise<string> {
  return new SignJWT({ sub: '0198f0d8-9999-8000-8000-000000000001', role: 'ADMIN', jti: 'jti-1', epoch: 0 })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(secret));
}

/** The api after the user context, the cart and the internal reads left it. */
describe('The api without its own auth (integration)', () => {
  let app: INestApplication;
  let probe: (token: string) => request.Test;

  const statuses = async (routes: [Method, string][]): Promise<string[]> => {
    const answers: string[] = [];
    for (const [method, path] of routes) {
      const res = await request(app.getHttpServer())[method](path).send({});
      answers.push(`${method} ${path} ${res.status}`);
    }
    return answers;
  };

  beforeAll(async () => {
    // Unset rather than inherited, so booting does not depend on a caller token the api no longer admits.
    app = await createTestApp({
      INTERNAL_CALLER_TOKEN_ORDER_SERVICE: undefined,
      INTERNAL_CALLER_TOKEN_ORDER_SERVICE_PREVIOUS: undefined,
    });
    probe = await createAdminProbe(app);
  });
  closeAppAfterAll(() => app);

  it('boots and is ready with no caller token configured', async () => {
    await request(app.getHttpServer()).get('/health/ready').expect(200);
  });

  it('accepts an ES256 token from the user-service', async () => {
    const { accessToken } = await createTestAdminPrincipal(app);

    expect((await probe(accessToken)).status).toBe(200);
  });

  it('refuses an HS256 token whatever it is signed with', async () => {
    expect((await probe(await hs256(randomBytes(32).toString('hex')))).status).toBe(401);
  });

  it('serves none of the auth routes it used to own', async () => {
    expect(await statuses(AUTH_ROUTES)).toEqual(AUTH_ROUTES.map(([method, path]) => `${method} ${path} 404`));
  });

  it('serves no cart and no internal route', async () => {
    expect(await statuses(RETIRED_ROUTES)).toEqual(RETIRED_ROUTES.map(([method, path]) => `${method} ${path} 404`));
  });
});
