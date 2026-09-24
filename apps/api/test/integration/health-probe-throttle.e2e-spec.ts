import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withRedisDown } from '../setup/redis-outage';
import { createTestApp } from '../setup/test-app.factory';

// Overshoots the global floor of 100 requests per 60s.
const PROBES = 120;

describe('Health probes vs rate limiting (integration, real Redis)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.THROTTLE_ENABLED = 'true';
    app = await createTestApp();
  });

  // Clears the opt-in so the next file in this worker boots with rate limiting off.
  afterAll(async () => {
    await app.close();
    delete process.env.THROTTLE_ENABLED;
  });

  it('never throttles liveness or readiness, however often they are probed', async () => {
    const failures: string[] = [];
    for (const path of ['/health/live', '/health/ready']) {
      for (let i = 0; i < PROBES; i += 1) {
        const res = await request(app.getHttpServer()).get(path);
        if (res.status !== 200) failures.push(`${path} ${res.status}`);
      }
    }

    expect(failures).toEqual([]);
  });

  it('leaves ordinary traffic unthrottled after a probe flood', async () => {
    const res = await request(app.getHttpServer()).get('/products');

    expect(res.status).toBe(200);
  });

  // Every active throttle tier touches Redis first, so an outage shows whether the guard runs at all.
  describe('with Redis down', () => {
    it('still answers liveness', async () => {
      await withRedisDown(app, async () => {
        await request(app.getHttpServer()).get('/health/live').expect(200);
      });
    });

    it('reports readiness as 503 naming the dependency', async () => {
      await withRedisDown(app, async () => {
        const res = await request(app.getHttpServer()).get('/health/ready');

        expect(res.status).toBe(503);
        expect(res.body.error).toHaveProperty('redis');
      });
    });
  });
});
