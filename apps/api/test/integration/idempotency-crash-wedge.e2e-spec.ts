import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  IDEMPOTENCY_STORE,
  type IdempotencyStorePort,
} from '../../src/modules/order/application/ports/idempotency-store.port';
import { CheckoutOrderUseCase } from '../../src/modules/order/application/use-cases/checkout-order.use-case';
import { DRIZZLE, PG_POOL, type DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import { authHeader } from '../setup/bearer.helper';
import { buyerWithCart, seedSellableSku, type SellableSku } from '../setup/fixtures/order-flow.fixture';
import { idempotencyKeyHeader } from '../setup/idempotency.helper';
import { resetDatabase } from '../setup/reset-database';
import { createTestApp } from '../setup/test-app.factory';

const STOCK = 50;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const CLOCK_TOLERANCE_MS = 5_000;

// A SIGKILLed pod runs no cleanup, so it leaves the lease the interceptor wrote, not a backdated one.
describe('Idempotency after a crash mid-checkout (integration, real Postgres)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;
  let checkout: CheckoutOrderUseCase;
  let store: IdempotencyStorePort;
  let sku: SellableSku;

  beforeAll(async () => {
    app = await createTestApp();
    pool = app.get<Pool>(PG_POOL);
    db = app.get<DrizzleDB>(DRIZZLE);
    checkout = app.get(CheckoutOrderUseCase);
    store = app.get<IdempotencyStorePort>(IDEMPOTENCY_STORE);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
    sku = await seedSellableSku(app, { onHand: STOCK });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const postOrder = (token: string, key: string) =>
    request(app.getHttpServer()).post('/orders').set(authHeader(token)).set(idempotencyKeyHeader(key));

  const keyRow = async (key: string) =>
    (await db.select().from(schema.idempotencyKeys).where(eq(schema.idempotencyKeys.key, key)))[0];

  const ordersOf = async (token: string) => {
    const res = await request(app.getHttpServer()).get('/orders').set(authHeader(token));
    return (res.body as { items: { id: string }[] }).items;
  };

  // The handler and the interceptor's cleanup both die with the process.
  async function crashMidCheckout(token: string, key: string): Promise<void> {
    vi.spyOn(checkout, 'execute').mockRejectedValue(new Error('SIGKILL: pod evicted'));
    vi.spyOn(store, 'deleteInProgress').mockResolvedValue(undefined);

    await postOrder(token, key).expect(500);

    vi.restoreAllMocks();
  }

  // Known defect. Intended: a key whose owner died is reclaimable within a window a client can wait
  // out, and the 409 says how long. Actual: IdempotencyInterceptor leases IN_PROGRESS for the 24h
  // IDEMPOTENCY_TTL_MS replay window, and its 409 carries no Retry-After or reason code.
  it('wedges a key for a full day when the pod dies mid-checkout, and never says so', async () => {
    const token = await buyerWithCart(app, sku.variantId, 1);
    const key = randomUUID();

    await crashMidCheckout(token, key);

    const wedged = await keyRow(key);
    expect(wedged.status).toBe('IN_PROGRESS');
    expect(wedged.expiresAt.getTime() - Date.now()).toBeGreaterThan(ONE_DAY_MS - CLOCK_TOLERANCE_MS);

    const retry = await postOrder(token, key).expect(409);
    expect(retry.body.message).toBe('A request with this Idempotency-Key is already in progress');
    expect(retry.headers['retry-after']).toBeUndefined();
    expect(retry.body).not.toHaveProperty('code');

    // A retry does not renew the lease.
    expect((await keyRow(key)).expiresAt.getTime()).toBe(wedged.expiresAt.getTime());
    expect(await ordersOf(token)).toHaveLength(0);

    // The cart is untouched, so a new key still buys the order.
    const fresh = await postOrder(token, randomUUID()).expect(201);
    expect(fresh.body.id).toBeDefined();
    expect(await ordersOf(token)).toHaveLength(1);
  });
});
