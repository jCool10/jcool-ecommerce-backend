import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { authHeader } from '../setup/bearer.helper';
import { createTestPrincipal } from '../setup/fixtures/principal.fixture';
import { closeAppAfterAll, createTestAppWithPool } from '../setup/harness';

const ID = '00000000-0000-4000-8000-000000000000';

type Route = readonly [method: 'get' | 'post' | 'put' | 'patch' | 'delete', path: string];

const BUYER_ROUTES: Route[] = [
  ['get', '/cart'],
  ['post', '/cart/items'],
  ['patch', `/cart/items/${ID}`],
  ['delete', `/cart/items/${ID}`],
  ['delete', '/cart'],
  ['post', '/orders'],
  ['get', '/orders'],
  ['get', `/orders/${ID}`],
  ['post', `/orders/${ID}/cancel`],
  ['post', `/orders/${ID}/pay`],
];

const ADMIN_ROUTES: Route[] = [
  ['get', '/admin/orders'],
  ['get', `/admin/orders/${ID}`],
  ['post', `/admin/orders/${ID}/cancel`],
  ['post', '/admin/categories'],
  ['patch', `/admin/categories/${ID}`],
  ['delete', `/admin/categories/${ID}`],
  ['post', '/admin/products'],
  ['patch', `/admin/products/${ID}`],
  ['delete', `/admin/products/${ID}`],
  ['post', `/admin/products/${ID}/skus`],
  ['patch', `/admin/skus/${ID}`],
  ['delete', `/admin/skus/${ID}`],
  ['put', `/admin/skus/${ID}/price`],
  ['get', `/admin/products/${ID}/images`],
  ['post', `/admin/products/${ID}/images`],
  ['patch', `/admin/products/${ID}/images`],
  ['delete', `/admin/products/${ID}/images/${ID}`],
  ['get', `/admin/inventory/${ID}`],
  ['put', `/admin/inventory/${ID}`],
  ['post', `/admin/inventory/${ID}/adjust`],
  ['post', '/admin/media/uploads'],
  ['post', `/admin/media/uploads/${ID}/complete`],
];

// Guards run before validation and lookup, so an empty body and an unknown id still reach them.
describe('Route authorization (integration)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    ({ app } = await createTestAppWithPool());
  });
  closeAppAfterAll(() => app);

  async function statuses(routes: Route[], token?: string): Promise<string[]> {
    const answers: string[] = [];
    for (const [method, path] of routes) {
      const req = request(app.getHttpServer())[method](path);
      const res = await (token === undefined ? req : req.set(authHeader(token)));
      answers.push(`${method.toUpperCase()} ${path} ${res.status}`);
    }
    return answers;
  }

  const expecting = (routes: Route[], status: number): string[] =>
    routes.map(([method, path]) => `${method.toUpperCase()} ${path} ${status}`);

  it('answers 401 without a token on every buyer and admin route', async () => {
    const routes = [...BUYER_ROUTES, ...ADMIN_ROUTES];

    expect(await statuses(routes)).toEqual(expecting(routes, 401));
  });

  it('answers 403 to a signed-in buyer on every admin route', async () => {
    const { accessToken } = await createTestPrincipal(app);

    expect(await statuses(ADMIN_ROUTES, accessToken)).toEqual(expecting(ADMIN_ROUTES, 403));
  });
});
