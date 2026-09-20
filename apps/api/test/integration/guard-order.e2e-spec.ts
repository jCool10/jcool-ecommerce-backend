import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RedisService } from '@jcool/platform/redis';
import { DEFAULT_THROTTLER, GLOBAL_THROTTLERS } from '@jcool/platform/throttler';
import { authHeader } from '../setup/bearer.helper';
import { createTestApp } from '../setup/test-app.factory';

const DEFAULT_LIMIT = GLOBAL_THROTTLERS.find((tier) => tier.name === DEFAULT_THROTTLER)?.limit;

/**
 * The throttler has to run before the token guard. The other way round, a bad bearer is refused
 * before it is ever counted, so a flood of them is never shed and every one of them costs a
 * signature check.
 */
describe('Global guard order (integration, real Redis)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.THROTTLE_ENABLED = 'true';
    app = await createTestApp();
    // Counters outlive the process; a re-run inside the window would start partway through the budget.
    await app.get(RedisService).getClient().flushdb();
  });

  afterAll(async () => {
    await app?.close();
    delete process.env.THROTTLE_ENABLED;
  });

  it('sheds a flood of forged bearers with 429, not an endless stream of 401s', async () => {
    if (typeof DEFAULT_LIMIT !== 'number') throw new Error('the default tier has no static limit');
    const forged = () => request(app.getHttpServer()).get('/cart').set(authHeader('not.a.token'));

    for (let attempt = 0; attempt < DEFAULT_LIMIT; attempt++) {
      expect((await forged()).status).toBe(401);
    }

    expect((await forged()).status).toBe(429);
  });
});
