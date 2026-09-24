import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { ShutdownService } from '@jcool/platform/health';
import { closeAppAfterAll } from '../setup/harness';
import { createTestApp } from '../setup/test-app.factory';

// Redis connects lazily, so the first readiness probe can answer 503 before the socket is up.
async function waitForReady(app: INestApplication, attempts = 50): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    const res = await request(app.getHttpServer()).get('/health/ready');
    if (res.status === 200) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('app did not reach readiness within the warm-up window');
}

describe('Health shutdown-aware readiness (integration, real Postgres + Redis)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
    await waitForReady(app);
  });
  closeAppAfterAll(() => app);

  it('turns readiness to 503 once draining while liveness stays 200', async () => {
    const before = await request(app.getHttpServer()).get('/health/ready');
    expect(before.status).toBe(200);
    expect(before.body.status).toBe('ok');

    await app.get(ShutdownService).beforeApplicationShutdown('SIGTERM');

    const ready = await request(app.getHttpServer()).get('/health/ready');
    expect(ready.status).toBe(503);
    expect(ready.body.status).toBe('error');
    expect(ready.body.details.shutdown.status).toBe('down');
    await request(app.getHttpServer()).get('/health/live').expect(200);
  });
});
