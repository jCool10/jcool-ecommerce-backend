import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PG_POOL } from '../../src/shared/infrastructure/database/drizzle.tokens';
import { RedisService } from '../../src/shared/infrastructure/redis';
import { ORDER_THROTTLE, USER_THROTTLER } from '../../src/shared/infrastructure/throttler';
import { authHeader } from '../setup/auth.helper';
import { createTestUser } from '../setup/fixtures/user.fixture';
import { idempotencyKeyHeader } from '../setup/idempotency.helper';
import { resetDatabase } from '../setup/reset-database';
import { createTestApp } from '../setup/test-app.factory';

const METRICS_TOKEN = 'e2e-rate-limit-token-abcdef';
// Read from the shipped config, so retuning the limit retunes the suite instead of breaking it.
const USER_LIMIT = ORDER_THROTTLE[USER_THROTTLER].limit;

// Rate limiting is off in the default harness (the shared loopback IP would make every suite
// flaky), so this suite opts in explicitly and boots its own app with THROTTLE_ENABLED='true'.
describe('Rate limiting on sensitive endpoints (integration, real Redis)', () => {
  let app: INestApplication;
  let pool: Pool;

  beforeAll(async () => {
    process.env.THROTTLE_ENABLED = 'true';
    process.env.METRICS_TOKEN = METRICS_TOKEN;
    app = await createTestApp();
    pool = app.get<Pool>(PG_POOL);
    await resetDatabase(pool);
    // Throttler counters live in Redis and outlive the process, so a re-run inside one window
    // would start partway through the IP budget these assertions depend on.
    await app.get(RedisService).getClient().flushdb();
  });

  afterAll(async () => {
    await app.close();
    // Don't leak the flags into other e2e suites sharing this worker's env.
    delete process.env.THROTTLE_ENABLED;
    delete process.env.METRICS_TOKEN;
  });

  // Checkout with an empty cart, which the limiter counts like any other attempt — it runs on the
  // way in, long before the cart is read.
  function postOrder(token: string): request.Test {
    return request(app.getHttpServer()).post('/orders').set(authHeader(token)).set(idempotencyKeyHeader()).send();
  }

  async function readRejections(tier: string, route: string): Promise<number> {
    const res = await request(app.getHttpServer())
      .get('/metrics')
      .set('Authorization', `Bearer ${METRICS_TOKEN}`)
      .expect(200);
    const line = new RegExp(
      `^rate_limit_rejections_total\\{(?=[^}]*tier="${tier}")(?=[^}]*route="${route}")[^}]*\\} (\\d+)`,
      'm',
    ).exec(res.text);
    return line ? Number(line[1]) : 0;
  }

  it('caps one account at the checkout endpoint without touching another account on the same IP', async () => {
    const alice = await createTestUser(app);
    const bob = await createTestUser(app);
    const rejectionsBefore = await readRejections('user', '/orders');

    for (let attempt = 0; attempt < USER_LIMIT; attempt++) {
      const allowed = await postOrder(alice.accessToken);
      expect(allowed.status).not.toBe(429);
    }

    const limited = await postOrder(alice.accessToken);
    expect(limited.status).toBe(429);

    // The point of keying by user rather than by IP: two accounts behind one address are two
    // buckets, so one of them spamming checkout can't lock the other out.
    const bystander = await postOrder(bob.accessToken);
    expect(bystander.status).not.toBe(429);

    expect(await readRejections('user', '/orders')).toBe(rejectionsBefore + 1);
  });

  it('enforces nothing while the kill-switch is off', async () => {
    const carol = await createTestUser(app);
    process.env.THROTTLE_ENABLED = 'false';

    try {
      for (let attempt = 0; attempt < USER_LIMIT + 1; attempt++) {
        const res = await postOrder(carol.accessToken);
        expect(res.status).not.toBe(429);
      }
    } finally {
      process.env.THROTTLE_ENABLED = 'true';
    }
  });
});
