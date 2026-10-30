import type { INestApplication } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import type { Pool } from 'pg';
import request from 'supertest';
import { type MockInstance, afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiReadRoutes } from '@jcool/internal-contracts';
import {
  API_READ_CONTRACT_CASES,
  type ApiReadContractDriver,
  apiReadHttpContractDriver,
  runApiReadContractCase,
} from '@jcool/internal-contracts/testing';
import { RedisService } from '@jcool/platform/redis';
import { authHeader } from '../setup/bearer.helper';
import { seedCart, seedCatalogSku } from '../setup/cart.helper';
import { createTestPrincipal } from '../setup/fixtures/principal.fixture';
import { closeAppAfterAll, createTestAppWithPool, resetDatabaseBeforeEach } from '../setup/harness';
import { testId } from '../setup/id-service-stub';
import { createTestApp } from '../setup/test-app.factory';

const ORDER_SERVICE_TOKEN = process.env.INTERNAL_CALLER_TOKEN_ORDER_SERVICE ?? '';

// Past the default tier's 100 per minute.
const BURST = 150;

const asOrderService = (test: request.Test) => test.set('authorization', `Bearer ${ORDER_SERVICE_TOKEN}`);

describe('Api read contract over the internal API', () => {
  let app: INestApplication;
  let pool: Pool;
  let driver: ApiReadContractDriver;

  beforeAll(async () => {
    ({ app, pool } = await createTestAppWithPool());
    driver = apiReadHttpContractDriver({
      baseUrl: await app.getUrl(),
      token: ORDER_SERVICE_TOKEN,
      newId: testId,
      seedSku: (seed) => seedCatalogSku(app, seed),
      seedCart: (lines) => seedCart(app, lines),
    });
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  it.each(API_READ_CONTRACT_CASES)('$name', (contractCase) => runApiReadContractCase(driver, contractCase));

  it('refuses a malformed user id or SKU id with 400', async () => {
    await asOrderService(request(app.getHttpServer()).get(apiReadRoutes.cartLines('not-an-id'))).expect(400);
    await asOrderService(request(app.getHttpServer()).post(apiReadRoutes.skuViews))
      .send({ skuIds: [testId(), 'sku-1'] })
      .expect(400);
  });

  it('refuses a missing or unknown token, a buyer token included, with 401', async () => {
    const { accessToken } = await createTestPrincipal(app);
    const cart = apiReadRoutes.cartLines(testId());

    await request(app.getHttpServer()).get(cart).expect(401);
    await request(app.getHttpServer()).get(cart).set('authorization', 'Bearer not-the-order-service').expect(401);
    await request(app.getHttpServer()).get(cart).set(authHeader(accessToken)).expect(401);
    await request(app.getHttpServer())
      .post(apiReadRoutes.skuViews)
      .send({ skuIds: [testId()] })
      .expect(401);
  });

  it('answers only the contract fields', async () => {
    const { skuId } = await seedCatalogSku(app, { priceMinor: 10_000 });
    const userId = await seedCart(app, [{ skuId, quantity: 2 }]);

    const lines = await asOrderService(request(app.getHttpServer()).get(apiReadRoutes.cartLines(userId))).expect(200);
    const views = await asOrderService(request(app.getHttpServer()).post(apiReadRoutes.skuViews))
      .send({ skuIds: [skuId] })
      .expect(200);

    expect(Object.keys(lines.body)).toEqual(['lines']);
    expect(Object.keys(lines.body.lines[0]).sort()).toEqual(['quantity', 'skuId']);
    expect(Object.keys(views.body)).toEqual(['views']);
    expect(Object.keys(views.body.views[0]).sort()).toEqual([
      'currency',
      'isActive',
      'productName',
      'skuId',
      'unitPriceMinor',
    ]);
  });
});

// Every call comes from the order-service's one address, where a per-IP limit would throttle checkout.
describe('Throttling on the internal read API (integration)', () => {
  let app: INestApplication;
  let increment: MockInstance<ThrottlerStorage['increment']>;

  beforeAll(async () => {
    // On, so "never throttled" is a claim about the routes rather than about the harness.
    process.env.THROTTLE_ENABLED = 'true';
    app = await createTestApp();
    await app.get(RedisService).getClient().flushdb();
    increment = vi.spyOn(app.get(ThrottlerStorage, { strict: false }), 'increment');
  });

  beforeEach(() => {
    increment.mockClear();
  });

  // Throttle counters outlive the app, and the control burst spends the catalog's budget for the next
  // file in this worker.
  afterAll(async () => {
    await app.get(RedisService).getClient().flushdb();
    await app.close();
    delete process.env.THROTTLE_ENABLED;
  });

  it.each([
    ['cart lines', () => asOrderService(request(app.getHttpServer()).get(apiReadRoutes.cartLines(testId())))],
    [
      'SKU views',
      () => asOrderService(request(app.getHttpServer()).post(apiReadRoutes.skuViews)).send({ skuIds: [testId()] }),
    ],
  ])(`never counts, let alone refuses, ${BURST} rapid %s reads from one address`, async (_route, read) => {
    const refused: number[] = [];
    for (let i = 0; i < BURST; i += 1) {
      const { status } = await read();
      if (status !== 200) refused.push(status);
    }

    expect(refused).toEqual([]);
    expect(increment).not.toHaveBeenCalled();
  });

  // The control: the same burst on a public route of this app does get refused.
  it(`refuses part of ${BURST} rapid catalog reads from one address`, async () => {
    const statuses = new Set<number>();
    for (let i = 0; i < BURST; i += 1) {
      statuses.add((await request(app.getHttpServer()).get('/products')).status);
    }

    expect([...statuses].sort()).toEqual([200, 429]);
    expect(increment).toHaveBeenCalled();
  });
});
