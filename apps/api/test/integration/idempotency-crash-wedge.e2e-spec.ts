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
// Mirrors IdempotencyInterceptor's IN_PROGRESS_LEASE_MS.
const LEASE_MS = 30 * 1000;

// A SIGKILLed pod runs no cleanup, so it leaves the row exactly as the interceptor's own insert wrote
// it — no backdating, until the test ages it past the lease itself.
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

  it('reclaims a key wedged by a mid-checkout crash once its lease passes, with no double order', async () => {
    const token = await buyerWithCart(app, sku.variantId, 1);
    const key = randomUUID();

    await crashMidCheckout(token, key);

    const wedged = await keyRow(key);
    expect(wedged.status).toBe('IN_PROGRESS');

    // Immediately after the crash the row is still inside its lease: a retry cannot tell a dead
    // owner from one that is simply still running, so it 409s rather than racing it.
    const tooSoon = await postOrder(token, key).expect(409);
    expect(tooSoon.body.message).toBe('A request with this Idempotency-Key is already in progress');
    expect(await ordersOf(token)).toHaveLength(0);

    // Age the row past the lease without a real wait — the crash left no cleanup to race against.
    await db
      .update(schema.idempotencyKeys)
      .set({ createdAt: new Date(Date.now() - LEASE_MS - 1_000) })
      .where(eq(schema.idempotencyKeys.key, key));

    const retry = await postOrder(token, key).expect(201);
    expect(retry.body.id).toBeDefined();
    expect(await ordersOf(token)).toHaveLength(1);

    const healed = await keyRow(key);
    expect(healed.status).toBe('COMPLETED');
    expect(healed.orderId).toBe(retry.body.id);
  });
});
