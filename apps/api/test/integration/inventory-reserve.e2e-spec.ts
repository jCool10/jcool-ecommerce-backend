import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { authHeader } from '../setup/bearer.helper';
import { idempotencyKeyHeader } from '../setup/idempotency.helper';
import { createTestProduct } from '../setup/fixtures/catalog.fixture';
import { seedStock } from '../setup/fixtures/inventory.fixture';
import { addToCart, readStock, reservationsFor } from '../setup/fixtures/order-flow.fixture';
import { newPrincipalToken } from '../setup/fixtures/principal.fixture';
import { closeAppAfterAll, createTestAppWithPool, resetDatabaseBeforeEach } from '../setup/harness';

// Each lock strategy is pinned at the participant (inventory-participant); races live in
// checkout-oversell, inventory-optimistic-* and inventory-mixed-strategy.
describe('Inventory reserve (integration, real Postgres)', () => {
  let app: INestApplication;
  let pool: Pool;

  beforeAll(async () => {
    ({ app, pool } = await createTestAppWithPool());
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  const server = () => app.getHttpServer();

  it('holds every line of a placed order', async () => {
    const token = await newPrincipalToken(app);
    const productA = await createTestProduct(app, { priceMinor: 100_000 });
    const productB = await createTestProduct(app, { priceMinor: 50_000 });
    await seedStock(app, productA.variantId, 10);
    await seedStock(app, productB.variantId, 10);
    await addToCart(app, token, productA.variantId, 3);
    await addToCart(app, token, productB.variantId, 2);

    const res = await request(server()).post('/orders').set(authHeader(token)).set(idempotencyKeyHeader());

    expect(res.status).toBe(201);
    expect(await readStock(app, productA.variantId)).toMatchObject({ quantityOnHand: 10, quantityReserved: 3 });
    expect(await readStock(app, productB.variantId)).toMatchObject({ quantityOnHand: 10, quantityReserved: 2 });
    expect(await reservationsFor(app, res.body.id, productA.variantId)).toEqual([
      expect.objectContaining({ status: 'HELD', quantity: 3 }),
    ]);
    expect(await reservationsFor(app, res.body.id, productB.variantId)).toEqual([
      expect.objectContaining({ status: 'HELD', quantity: 2 }),
    ]);
  });

  it('rolls back every line when one line is short', async () => {
    const token = await newPrincipalToken(app);
    const productA = await createTestProduct(app, { priceMinor: 100_000 });
    const productB = await createTestProduct(app, { priceMinor: 50_000 });
    await seedStock(app, productA.variantId, 5);
    await seedStock(app, productB.variantId, 1);
    await addToCart(app, token, productA.variantId, 2);
    await addToCart(app, token, productB.variantId, 3);

    const res = await request(server()).post('/orders').set(authHeader(token)).set(idempotencyKeyHeader());

    expect(res.status).toBe(409);
    expect(await readStock(app, productA.variantId)).toMatchObject({ quantityReserved: 0 });
    expect(await readStock(app, productB.variantId)).toMatchObject({ quantityReserved: 0 });
  });

  it('refuses a SKU that has no stock row', async () => {
    const token = await newPrincipalToken(app);
    const product = await createTestProduct(app, { priceMinor: 100_000 });
    await addToCart(app, token, product.variantId, 1);

    const res = await request(server()).post('/orders').set(authHeader(token)).set(idempotencyKeyHeader());

    expect(res.status).toBe(409);
    expect(res.body.message).toBe('Insufficient stock');
  });

  it('replays the placed order for a repeated key, holding its stock once', async () => {
    const token = await newPrincipalToken(app);
    const product = await createTestProduct(app, { priceMinor: 100_000 });
    await seedStock(app, product.variantId, 5);
    await addToCart(app, token, product.variantId, 2);

    const key = idempotencyKeyHeader();
    const res1 = await request(server()).post('/orders').set(authHeader(token)).set(key);
    const res2 = await request(server()).post('/orders').set(authHeader(token)).set(key);

    expect(res1.status).toBe(201);
    expect(res2.status).toBe(201);
    expect(res1.body.id).toBe(res2.body.id);
    expect(await readStock(app, product.variantId)).toMatchObject({ quantityReserved: 2 });
  });

  it('refuses a direct write that reserves more than is on hand', async () => {
    const product = await createTestProduct(app, { priceMinor: 100_000 });
    await seedStock(app, product.variantId, 2);

    await expect(
      pool.query('UPDATE stock_levels SET quantity_reserved = 3 WHERE variant_id = $1', [product.variantId]),
    ).rejects.toThrow(/ck_stock_no_oversell/);
  });
});
