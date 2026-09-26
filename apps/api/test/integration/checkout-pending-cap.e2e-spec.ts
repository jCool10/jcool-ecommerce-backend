import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { MAX_PENDING_ORDERS_PER_USER } from '../../src/modules/order/order.constants';
import { authHeader } from '../setup/bearer.helper';
import { createTestProduct } from '../setup/fixtures/catalog.fixture';
import { seedStock } from '../setup/fixtures/inventory.fixture';
import { addToCart, checkout } from '../setup/fixtures/order-flow.fixture';
import { newPrincipalToken } from '../setup/fixtures/principal.fixture';
import { closeAppAfterAll, createTestAppWithPool, resetDatabaseBeforeEach } from '../setup/harness';

// Ample stock and one shared cart line isolate the cap: every contender races the same SKU with a
// fresh Idempotency-Key, so only the pending-order count — never stock — can turn any of them away.
const CONTENDERS = 10;
const AMPLE_STOCK = 100;

const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

describe('Checkout pending-order cap (integration, real Postgres)', () => {
  let app: INestApplication;
  let pool: Pool;

  beforeAll(async () => {
    ({ app, pool } = await createTestAppWithPool());
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  const server = () => app.getHttpServer();

  it('lets exactly the cap through when one user races checkout with fresh keys', async () => {
    const token = await newPrincipalToken(app);
    const { variantId } = await createTestProduct(app, { priceMinor: 100_000 });
    await seedStock(app, variantId, AMPLE_STOCK);
    await addToCart(app, token, variantId, 1);

    const settled = await Promise.allSettled(range(CONTENDERS).map(() => checkout(app, token)));
    const statuses = settled.map((r) => (r.status === 'fulfilled' ? r.value.status : 'errored'));

    expect(statuses.filter((s) => s === 201)).toHaveLength(MAX_PENDING_ORDERS_PER_USER);
    expect(statuses.filter((s) => s === 409)).toHaveLength(CONTENDERS - MAX_PENDING_ORDERS_PER_USER);
    expect(statuses.filter((s) => s === 'errored')).toHaveLength(0);

    const list = await request(server()).get('/orders').set(authHeader(token));
    expect(list.body.items).toHaveLength(MAX_PENDING_ORDERS_PER_USER);
    expect(list.body.items.every((o: { status: string }) => o.status === 'PENDING')).toBe(true);
  });

  it('frees a slot once a pending order is cancelled', async () => {
    const token = await newPrincipalToken(app);
    const { variantId } = await createTestProduct(app, { priceMinor: 100_000 });
    await seedStock(app, variantId, AMPLE_STOCK);
    await addToCart(app, token, variantId, 1);

    for (let i = 0; i < MAX_PENDING_ORDERS_PER_USER; i++) {
      await checkout(app, token).expect(201);
    }
    await checkout(app, token).expect(409);

    const list = await request(server()).get('/orders').set(authHeader(token));
    await request(server()).post(`/orders/${list.body.items[0].id}/cancel`).set(authHeader(token)).expect(200);

    await checkout(app, token).expect(201);
  });
});
