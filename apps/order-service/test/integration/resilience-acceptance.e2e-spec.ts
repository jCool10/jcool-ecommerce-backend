import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RedisService } from '@jcool/platform/redis';
import { DEFAULT_THROTTLER, ORDER_THROTTLE, USER_THROTTLER } from '@jcool/platform/throttler';
import { authHeader } from '../setup/bearer.helper';
import { createTestPrincipal } from '../setup/fixtures/principal.fixture';
import { createTestAppWithPool } from '../setup/harness';
import { idempotencyKeyHeader } from '../setup/idempotency.helper';
import { E2E_METRICS_TOKEN, metricsAuthHeader } from '../setup/metrics.helper';
import { resetDatabase } from '../setup/reset-database';

const IP_LIMIT = ORDER_THROTTLE[DEFAULT_THROTTLER].limit;
const USER_LIMIT = ORDER_THROTTLE[USER_THROTTLER].limit;

// The checkout half of the api's suite of the same name; the cache and breaker half stayed there.
describe('Resilience acceptance: cache, limiter, and breaker in one app (integration)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const booted = await createTestAppWithPool({ THROTTLE_ENABLED: 'true', METRICS_TOKEN: E2E_METRICS_TOKEN });
    app = booted.app;
    // The guard reads the kill-switch per request, and createTestApp put the harness default back.
    process.env.THROTTLE_ENABLED = 'true';
    await resetDatabase(booted.pool);
  });

  afterAll(async () => {
    await app.close();
    process.env.THROTTLE_ENABLED = 'false';
  });

  const server = () => app.getHttpServer();

  async function rejections(tier: string): Promise<number> {
    const res = await request(server()).get('/metrics').set(metricsAuthHeader()).expect(200);
    const line = new RegExp(
      `^rate_limit_rejections_total\\{(?=[^}]*tier="${tier}")(?=[^}]*route="/orders")[^}]*\\} (\\d+)`,
      'm',
    ).exec(res.text);
    return line ? Number(line[1]) : 0;
  }

  function postOrder(token: string): request.Test {
    return request(server()).post('/orders').set(authHeader(token)).set(idempotencyKeyHeader()).send();
  }

  it('turns an account away at the IP tier while its own budget is untouched', async () => {
    // Throttler counters live in Redis and outlive the process, so a re-run could start mid-window.
    await app.get(RedisService).getClient().flushdb();
    const before = await rejections(DEFAULT_THROTTLER);

    for (let spent = 0; spent < IP_LIMIT;) {
      const { accessToken } = await createTestPrincipal(app);
      for (let i = 0; i < Math.min(USER_LIMIT, IP_LIMIT - spent); i++, spent++) {
        // 400, not merely "not 429": a fresh buyer has an empty cart, so a broken auth or route
        // cannot spend the budget silently.
        expect((await postOrder(accessToken)).status).toBe(400);
      }
    }

    const newcomer = await createTestPrincipal(app);
    expect((await postOrder(newcomer.accessToken)).status).toBe(429);
    expect(await rejections(DEFAULT_THROTTLER)).toBe(before + 1);
  });
});
