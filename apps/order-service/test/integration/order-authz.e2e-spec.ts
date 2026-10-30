import type { INestApplication } from '@nestjs/common';
import type Redis from 'ioredis';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { SESSION_EPOCH_KEY_PREFIX } from '@jcool/auth-verifier';
import { RedisService } from '@jcool/platform/redis';
import { authHeader } from '../setup/bearer.helper';
import { createTestPrincipal } from '../setup/fixtures/principal.fixture';
import { closeAppAfterAll, createTestAppWithPool } from '../setup/harness';
import { testId } from '../setup/id-service-stub';
import { userServiceStub } from '../setup/user-service-stub';

const ID = testId();

type Route = readonly [method: 'get' | 'post', path: string];

const BUYER_ROUTES: Route[] = [
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
];

// Guards run before validation and lookup, so an empty body and an unknown id still reach them.
describe('Route authorization (integration)', () => {
  let app: INestApplication;
  let redis: Redis;

  beforeAll(async () => {
    ({ app } = await createTestAppWithPool());
    redis = app.get(RedisService).getClient();
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

  // The token is still unexpired; only the user-service knows the sessions behind it were ended.
  it('refuses a token from a session the user-service has since revoked', async () => {
    const { user, accessToken } = await createTestPrincipal(app);
    await request(app.getHttpServer()).get('/orders').set(authHeader(accessToken)).expect(200);
    const stub = await userServiceStub();
    const asked = stub.calls('epoch');

    stub.bumpEpoch(user.id);
    await redis.del(SESSION_EPOCH_KEY_PREFIX + user.id);

    await request(app.getHttpServer()).get('/orders').set(authHeader(accessToken)).expect(401);
    expect(stub.calls('epoch')).toBe(asked + 1);
  });
});
