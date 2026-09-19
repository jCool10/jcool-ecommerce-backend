import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_THROTTLER, REFRESH_THROTTLE } from '@jcool/platform/throttler';
import { createTestApp } from '../setup/test-app.factory';
import { redisOf } from '../setup/harness';
import { E2E_METRICS_TOKEN, metricsAuthHeader } from '../setup/metrics.helper';

// From the shipped config, so retuning the limit retunes the suite.
const IP_LIMIT = REFRESH_THROTTLE[DEFAULT_THROTTLER].limit;
const ROUTE = '/auth/verify-email';

describe('Rate limiting on token-redeeming auth endpoints (integration, real Redis)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.THROTTLE_ENABLED = 'true';
    app = await createTestApp({ METRICS_TOKEN: E2E_METRICS_TOKEN });
    await redisOf(app).flushdb();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.THROTTLE_ENABLED;
  });

  // Unknown tokens: the limiter counts them like any other attempt, long before the lookup.
  function redeem(): request.Test {
    return request(app.getHttpServer())
      .post(ROUTE)
      .send({ token: randomBytes(32).toString('base64url') });
  }

  async function readRejections(tier: string, route: string): Promise<number> {
    const res = await request(app.getHttpServer()).get('/metrics').set(metricsAuthHeader()).expect(200);
    const line = new RegExp(
      `^rate_limit_rejections_total\\{(?=[^}]*tier="${tier}")(?=[^}]*route="${route}")[^}]*\\} (\\d+)`,
      'm',
    ).exec(res.text);
    return line ? Number(line[1]) : 0;
  }

  it('caps one IP guessing tokens, and counts the rejection by tier and route', async () => {
    const rejectionsBefore = await readRejections(DEFAULT_THROTTLER, ROUTE);

    for (let attempt = 0; attempt < IP_LIMIT; attempt++) {
      expect((await redeem()).status).toBe(400);
    }

    expect((await redeem()).status).toBe(429);
    expect(await readRejections(DEFAULT_THROTTLER, ROUTE)).toBe(rejectionsBefore + 1);
  });

  // Runs after the IP is blocked, so it also proves the switch overrides a live block.
  it('enforces nothing while the kill-switch is off', async () => {
    process.env.THROTTLE_ENABLED = 'false';
    try {
      for (let attempt = 0; attempt < IP_LIMIT + 1; attempt++) {
        expect((await redeem()).status).not.toBe(429);
      }
    } finally {
      process.env.THROTTLE_ENABLED = 'true';
    }
  });
});
