import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRedisDown } from '../setup/redis-outage';
import { createTestApp } from '../setup/test-app.factory';

// Rate limiting is off in the default harness, so this suite opts in explicitly — the whole point
// is what the guard does to probe traffic when it is switched on the way production runs it.
// The global floor is 100 requests / 60s, so PROBES overshoots it on purpose.
const PROBES = 120;

describe('Health probes vs rate limiting (integration, real Redis)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.THROTTLE_ENABLED = 'true';
    app = await createTestApp();
  });

  // Explicit rather than `closeAppAfterAll`: the opt-in flag has to be cleared too, or the next
  // file in this worker boots with rate limiting on.
  afterAll(async () => {
    await app.close();
    delete process.env.THROTTLE_ENABLED;
  });

  it('never throttles liveness, however often it is probed', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < PROBES; i += 1) {
      const res = await request(app.getHttpServer()).get('/health/live');
      statuses.push(res.status);
    }

    expect(statuses.filter((status) => status !== 200)).toEqual([]);
  });

  it('never throttles readiness — a 429 here would pull a healthy instance from service', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < PROBES; i += 1) {
      const res = await request(app.getHttpServer()).get('/health/ready');
      statuses.push(res.status);
    }

    expect(statuses.filter((status) => status !== 200)).toEqual([]);
  });

  // The other half of the guarantee: probes must not spend anyone else's quota either.
  it('leaves ordinary traffic unthrottled after a probe flood', async () => {
    const res = await request(app.getHttpServer()).get('/products');

    expect(res.status).toBe(200);
  });

  // The volume tests above pass even with a tier left active — the account ceiling is high enough
  // that 120 probes never reach it. Redis being down is what separates "not rate limited" from
  // "the guard is not in this request at all": every active tier increments a Redis counter first.
  describe('with Redis down', () => {
    it('still answers liveness, which depends on nothing', async () => {
      await withRedisDown(app, async () => {
        await request(app.getHttpServer()).get('/health/live').expect(200);
      });
    });

    it('reports readiness as 503 naming the dependency, not 500 from the guard', async () => {
      await withRedisDown(app, async () => {
        const res = await request(app.getHttpServer()).get('/health/ready');

        expect(res.status).toBe(503);
        expect(res.body.error).toHaveProperty('redis');
      });
    });
  });
});
