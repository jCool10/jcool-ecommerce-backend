import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import type { DrizzleDB } from '../../src/database';
import * as schema from '../../src/database/schema';
import { authHeader } from '../setup/bearer.helper';
import {
  archiveProduct,
  createTestProduct,
  dropSkuView,
  repriceSku,
  type TestProduct,
} from '../setup/fixtures/catalog.fixture';
import { seedStock } from '../setup/fixtures/inventory.fixture';
import { addToCart } from '../setup/fixtures/order-flow.fixture';
import { newPrincipalToken } from '../setup/fixtures/principal.fixture';
import { closeAppAfterAll, createTestAppWithPool, resetDatabaseBeforeEach } from '../setup/harness';
import { idempotencyKeyHeader } from '../setup/idempotency.helper';
import { type InventoryServiceStub, inventoryServiceStub } from '../setup/inventory-service-stub';

const MAX_CART_LINES = 100;

// Checkout reads the buyer's cart and the catalog read model from this service's own database.
describe('Checkout from the local cart and catalog read model (integration, real Postgres + Redis)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;
  let inventory: InventoryServiceStub;

  beforeAll(async () => {
    ({ app, pool, db } = await createTestAppWithPool());
    inventory = await inventoryServiceStub();
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  const checkout = (token: string): request.Test =>
    request(app.getHttpServer()).post('/orders').set(authHeader(token)).set(idempotencyKeyHeader());
  const orderRows = () => db.select({ id: schema.orders.id }).from(schema.orders);

  async function sellable(priceMinor: number): Promise<TestProduct> {
    const sku = await createTestProduct(app, { priceMinor });
    await seedStock(app, sku.variantId, 100);
    return sku;
  }

  async function expectRefused(token: string, message: string): Promise<void> {
    const res = await checkout(token);

    expect(res.status).toBe(400);
    expect(res.body.message).toBe(message);
    expect(await orderRows()).toEqual([]);
    expect(inventory.calls('try')).toBe(0);
  }

  it('refuses a SKU archived after it was added, naming it', async () => {
    const token = await newPrincipalToken(app);
    const live = await sellable(100_000);
    const archived = await sellable(50_000);
    await addToCart(app, token, live.variantId, 1);
    await addToCart(app, token, archived.variantId, 1);
    await archiveProduct(app, archived.productId);

    await expectRefused(token, `SKU is not available for order: ${archived.variantId}`);
  });

  it('refuses a SKU unpriced after it was added, naming it', async () => {
    const token = await newPrincipalToken(app);
    const live = await sellable(100_000);
    const unpriced = await sellable(50_000);
    await addToCart(app, token, live.variantId, 1);
    await addToCart(app, token, unpriced.variantId, 1);
    await repriceSku(app, unpriced.variantId, null);

    await expectRefused(token, `SKU is not purchasable (no price): ${unpriced.variantId}`);
  });

  // The missing line comes first: views matched by position would price the live line as the missing one.
  it('refuses a line whose SKU the read model no longer holds, naming that line', async () => {
    const token = await newPrincipalToken(app);
    const gone = await sellable(50_000);
    const live = await sellable(100_000);
    await addToCart(app, token, gone.variantId, 1);
    await addToCart(app, token, live.variantId, 1);
    await dropSkuView(app, gone.variantId);

    await expectRefused(token, `SKU no longer exists in catalog: ${gone.variantId}`);
  });

  it('refuses a cart whose every SKU left the read model', async () => {
    const token = await newPrincipalToken(app);
    const gone = await sellable(50_000);
    await addToCart(app, token, gone.variantId, 1);
    await dropSkuView(app, gone.variantId);

    await expectRefused(token, 'Cart items no longer exist in catalog');
  });

  it('snapshots the price of a reprice applied before checkout', async () => {
    const token = await newPrincipalToken(app);
    const sku = await sellable(100_000);
    await addToCart(app, token, sku.variantId, 2);
    await repriceSku(app, sku.variantId, 120_000);

    const res = await checkout(token).expect(201);

    expect(res.body.items).toEqual([
      expect.objectContaining({ skuId: sku.variantId, unitPriceMinor: 120_000, lineTotalMinor: 240_000 }),
    ]);
    expect(res.body.totalAmountMinor).toBe(240_000);
  });

  it('keeps a placed order at its price when the catalog reprices afterwards', async () => {
    const token = await newPrincipalToken(app);
    const sku = await sellable(100_000);
    await addToCart(app, token, sku.variantId, 1);
    const placed = await checkout(token).expect(201);

    await repriceSku(app, sku.variantId, 90_000);

    const read = await request(app.getHttpServer())
      .get(`/orders/${placed.body.id as string}`)
      .set(authHeader(token))
      .expect(200);
    expect(read.body.totalAmountMinor).toBe(100_000);
    expect(read.body.items[0].unitPriceMinor).toBe(100_000);
  });

  it('checks out a full cart, each line at its own price and name', async () => {
    const token = await newPrincipalToken(app);
    const skus: TestProduct[] = [];
    for (let line = 0; line < MAX_CART_LINES; line += 1) skus.push(await sellable(1_000 + line));
    for (const sku of skus) await addToCart(app, token, sku.variantId, 1);

    const res = await checkout(token).expect(201);

    expect(res.body.items).toHaveLength(MAX_CART_LINES);
    expect(res.body.totalAmountMinor).toBe(skus.reduce((total, sku) => total + (sku.priceMinor ?? 0), 0));
    const lineBySku = new Map<string, { productName: string; unitPriceMinor: number }>(
      (res.body.items as { skuId: string; productName: string; unitPriceMinor: number }[]).map((line) => [
        line.skuId,
        line,
      ]),
    );
    for (const sku of skus) {
      expect(lineBySku.get(sku.variantId), sku.variantId).toMatchObject({
        productName: sku.name,
        unitPriceMinor: sku.priceMinor,
      });
    }
  });
});
