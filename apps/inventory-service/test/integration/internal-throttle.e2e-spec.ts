import type { INestApplication } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import request from 'supertest';
import { type MockInstance, afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { reservationRoutes } from '@jcool/internal-contracts';
import { authHeader } from '../setup/bearer.helper';
import { createTestAdminPrincipal } from '../setup/fixtures/principal.fixture';
import { internalPost, redisOf } from '../setup/harness';
import { testId } from '../setup/id-service-stub';
import { createTestApp } from '../setup/test-app.factory';

// Past the default tier's 100 per minute.
const BURST = 150;

// Every call comes from the api's few private addresses, where a per-IP limit would throttle checkout
// as a whole.
describe('Throttling on the internal API (integration)', () => {
  let app: INestApplication;
  let increment: MockInstance<ThrottlerStorage['increment']>;

  beforeAll(async () => {
    // On, so "never throttled" is a claim about the routes rather than about the harness.
    process.env.THROTTLE_ENABLED = 'true';
    app = await createTestApp();
    await redisOf(app).flushdb();
    increment = vi.spyOn(app.get(ThrottlerStorage, { strict: false }), 'increment');
  });

  beforeEach(() => {
    increment.mockClear();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.THROTTLE_ENABLED;
  });

  it(`never counts, let alone refuses, ${BURST} rapid status reads from one address`, async () => {
    const orderIds = [testId()];

    const refused: number[] = [];
    for (let i = 0; i < BURST; i += 1) {
      const { status } = await internalPost(app, reservationRoutes.status).send({ orderIds });
      if (status !== 200) refused.push(status);
    }

    expect(refused).toEqual([]);
    expect(increment).not.toHaveBeenCalled();
  });

  // The control: the same burst on a throttled route of this app does get refused.
  it(`refuses part of ${BURST} rapid admin reads from one address`, async () => {
    const { accessToken } = await createTestAdminPrincipal(app);
    const path = `/admin/inventory/${testId()}`;

    const statuses = new Set<number>();
    for (let i = 0; i < BURST; i += 1) {
      statuses.add((await request(app.getHttpServer()).get(path).set(authHeader(accessToken))).status);
    }

    expect([...statuses].sort()).toEqual([404, 429]);
    expect(increment).toHaveBeenCalled();
  });
});
