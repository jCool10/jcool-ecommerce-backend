import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { UuidV8Generator } from '@shared/identity';
import { ID_CLOCK_DRIFT_MS } from '@shared/observability/metrics/identity-clock.collector';
import { createTestApp } from '../setup/test-app.factory';

const METRICS_TOKEN = 'e2e-identity-clock-token-abcdef';
const CLOCK_JUMP_MS = 90_000;
// Wall and monotonic readings floor to whole milliseconds independently, so absorbed drift can land
// a millisecond or two under the step. The claim is that the jump reached the gauge.
const CLOCK_READ_SKEW_MS = 2;
const ABSORBED_DRIFT_MS = CLOCK_JUMP_MS - CLOCK_READ_SKEW_MS;

// One registry serves the whole process and get-or-creates by name, so the drift gauge is created
// once and has to find whichever generator is currently minting. The collector's own suite proves
// that with fakes; this proves the wiring through real boots and a real /metrics scrape, because the
// failure it guards against — a gauge stuck on a dead generator — looks like a healthy clock.
describe('Identity clock metrics (integration)', () => {
  const started: INestApplication[] = [];

  async function boot(): Promise<INestApplication> {
    const app = await createTestApp();
    started.push(app);
    return app;
  }

  async function drift(app: INestApplication): Promise<number | undefined> {
    const res = await request(app.getHttpServer())
      .get('/metrics')
      .set('Authorization', `Bearer ${METRICS_TOKEN}`)
      .expect(200);

    const line = res.text.split('\n').find((candidate) => candidate.startsWith(`${ID_CLOCK_DRIFT_MS} `));
    return line === undefined ? undefined : Number(line.slice(ID_CLOCK_DRIFT_MS.length + 1));
  }

  // Drift is one-way catch-up, so stepping the wall clock forward over a single mint is the only way
  // to produce a reading no other app in the process shares.
  function absorbClockJump(app: INestApplication): void {
    const realNow = Date.now.bind(Date);
    const stepped = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + CLOCK_JUMP_MS);
    try {
      app.get(UuidV8Generator).generate(0);
    } finally {
      stepped.mockRestore();
    }
  }

  beforeAll(() => {
    process.env.METRICS_TOKEN = METRICS_TOKEN;
  });

  afterAll(() => {
    delete process.env.METRICS_TOKEN;
  });

  afterEach(async () => {
    // Reverse order, tolerant of an already-closed app: a leaked one keeps its generator bound and
    // hands the next test a reading it did not produce.
    for (const app of started.reverse()) {
      await app.close().catch(() => undefined);
    }
    started.length = 0;
  });

  it('reports the app that booted last, and survives an older one shutting down', async () => {
    const first = await boot();
    const second = await boot();

    await expect(drift(second)).resolves.toBe(0);
    absorbClockJump(second);

    // Through the FIRST app on purpose: both endpoints read the one registry, so a collector still
    // holding the first app's generator would answer with its untouched 0.
    await expect(drift(first)).resolves.toBeGreaterThanOrEqual(ABSORBED_DRIFT_MS);

    await first.close();

    await expect(drift(second)).resolves.toBeGreaterThanOrEqual(ABSORBED_DRIFT_MS);
  });

  it('withdraws the series when the app it was measuring closes', async () => {
    const first = await boot();
    const second = await boot();
    await expect(drift(first)).resolves.toBe(0);

    await second.close();

    // Absent, not zero: nothing is minting, and a 0 on a dashboard reads as a healthy clock.
    await expect(drift(first)).resolves.toBeUndefined();
  });
});
