import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ShutdownService } from '@shared/health/shutdown.service';
import { createTestApp } from '../setup/test-app.factory';

// Redis connects lazily (enableOfflineQueue:false), so the very first readiness probe can race
// the socket becoming writable — which is correct readiness behaviour (503 until deps are up).
// Wait for steady state the way an orchestrator would before asserting the healthy baseline.
async function waitForReady(app: INestApplication, attempts = 50): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    const res = await request(app.getHttpServer()).get('/health/ready');
    if (res.status === 200) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('app did not reach readiness within the warm-up window');
}

// Proves the shutdown-aware readiness wiring end-to-end: /health/ready flips to 503 once the
// process begins draining, while /health/live stays 200 (a draining process is still alive). Uses
// the real Nest lifecycle hook rather than an OS signal, so the assertion is deterministic.
describe('Health — shutdown-aware readiness (real Postgres + Redis)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
    await waitForReady(app);
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health/ready → 200 while serving normally', async () => {
    const res = await request(app.getHttpServer()).get('/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('GET /health/live → 200 (no dependency checked)', async () => {
    const res = await request(app.getHttpServer()).get('/health/live');
    expect(res.status).toBe(200);
  });

  // Ordered last: begins draining THIS app instance (one-way flag), so it must not precede the
  // healthy-state assertions above.
  it('once draining, GET /health/ready → 503 (shutdown gate) while /health/live stays 200', async () => {
    await app.get(ShutdownService).beforeApplicationShutdown('SIGTERM');

    const ready = await request(app.getHttpServer()).get('/health/ready');
    expect(ready.status).toBe(503);
    expect(ready.body.status).toBe('error');
    expect(ready.body.details.shutdown.status).toBe('down');

    const live = await request(app.getHttpServer()).get('/health/live');
    expect(live.status).toBe(200);
  });
});
