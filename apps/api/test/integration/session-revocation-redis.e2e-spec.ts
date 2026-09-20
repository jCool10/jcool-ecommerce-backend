import type { INestApplication } from '@nestjs/common';
import type Redis from 'ioredis';
import { decodeJwt } from 'jose';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_EPOCH_KEY_PREFIX, TOKEN_DENYLIST_KEY_PREFIX } from '@jcool/auth-verifier';
import { RedisService } from '@jcool/platform/redis';
import { authHeader } from '../setup/bearer.helper';
import { createTestPrincipal } from '../setup/fixtures/principal.fixture';
import { closeAppAfterAll } from '../setup/harness';
import { E2E_METRICS_TOKEN, metricsAuthHeader } from '../setup/metrics.helper';
import { createTestApp } from '../setup/test-app.factory';
import { type UserServiceStub, userServiceStub } from '../setup/user-service-stub';

/**
 * The user-service revokes by writing Redis; the api only reads it. So "logged out everywhere" is
 * only as fast as that read, and a key Redis no longer holds must neither open the door nor sign
 * everyone out.
 */
describe('Session revocation read from Redis (integration, real Redis)', () => {
  let app: INestApplication;
  let redis: Redis;
  let stub: UserServiceStub;

  const cart = (token: string) => request(app.getHttpServer()).get('/cart').set(authHeader(token));
  const epochKey = (userId: string) => SESSION_EPOCH_KEY_PREFIX + userId;

  beforeAll(async () => {
    stub = await userServiceStub();
    app = await createTestApp({ METRICS_TOKEN: E2E_METRICS_TOKEN });
    redis = app.get(RedisService).getClient();
  });
  closeAppAfterAll(() => app);

  beforeEach(() => stub.reset());

  it('refuses a token the moment its epoch moves past it', async () => {
    const { user, accessToken } = await createTestPrincipal(app);
    expect((await cart(accessToken)).status).toBe(200);

    // What a logout-all on the user-service publishes.
    await redis.set(epochKey(user.id), '1');

    expect((await cart(accessToken)).status).toBe(401);
    expect((await cart(await stub.sign(user, 1))).status).toBe(200);
  });

  it('refuses a token whose jti is denylisted', async () => {
    const { accessToken } = await createTestPrincipal(app);

    await redis.set(TOKEN_DENYLIST_KEY_PREFIX + decodeJwt(accessToken).jti, '1', 'EX', 60);

    expect((await cart(accessToken)).status).toBe(401);
  });

  it('asks the user-service when the epoch is missing, and leaves the key to it', async () => {
    const { user, accessToken } = await createTestPrincipal(app);
    await redis.del(epochKey(user.id));
    stub.bumpEpoch(user.id);

    expect((await cart(accessToken)).status).toBe(401);
    expect(stub.calls('epoch')).toBe(1);
    expect(await redis.exists(epochKey(user.id))).toBe(0);

    const { text } = await request(app.getHttpServer()).get('/metrics').set(metricsAuthHeader()).expect(200);
    expect(text).toMatch(/session_epoch_lookups_total\{result="miss"\} [1-9]/);
  });

  it('answers 503 while the user-service cannot say', async () => {
    const { user, accessToken } = await createTestPrincipal(app);
    await redis.del(epochKey(user.id));
    stub.fail('epoch', 503);

    expect((await cart(accessToken)).status).toBe(503);
  });

  it('refuses a user the user-service no longer has', async () => {
    const gone = { id: '0198f0d8-9999-8000-8000-000000000001', email: 'gone@test.local', role: 'CUSTOMER' as const };

    expect((await cart(await stub.sign(gone))).status).toBe(401);
    expect(stub.calls('epoch')).toBe(1);
  });
});
