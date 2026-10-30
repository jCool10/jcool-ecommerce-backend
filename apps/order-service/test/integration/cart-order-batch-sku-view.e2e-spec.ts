import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { MAX_SKU_VIEW_BATCH } from '@jcool/internal-contracts';
import type { DrizzleDB } from '../../src/database';
import * as schema from '../../src/database/schema';
import { type ApiInternalStub, apiInternalStub } from '../setup/api-internal-stub';
import { authHeader } from '../setup/bearer.helper';
import { archiveProduct, createTestProduct, repriceSku, type TestProduct } from '../setup/fixtures/catalog.fixture';
import { seedStock } from '../setup/fixtures/inventory.fixture';
import { addToCart } from '../setup/fixtures/order-flow.fixture';
import { newPrincipalToken } from '../setup/fixtures/principal.fixture';
import { closeAppAfterAll, createTestAppWithPool, resetDatabaseBeforeEach } from '../setup/harness';
import { idempotencyKeyHeader } from '../setup/idempotency.helper';
import { type InventoryServiceStub, inventoryServiceStub } from '../setup/inventory-service-stub';

// Checkout prices the whole cart through the api's batch read. The response alone cannot show how
// many reads that took, or that a line keeps its own view however the batch comes back.
describe('Batch SKU view (integration, real Postgres + Redis)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;
  let api: ApiInternalStub;
  let inventory: InventoryServiceStub;

  beforeAll(async () => {
    ({ app, pool, db } = await createTestAppWithPool());
    api = await apiInternalStub();
    inventory = await inventoryServiceStub();
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  const server = () => app.getHttpServer();
  const orderRows = () => db.select({ id: schema.orders.id }).from(schema.orders);

  async function sellable(priceMinor: number): Promise<TestProduct> {
    const sku = await createTestProduct(app, { priceMinor });
    await seedStock(app, sku.variantId, 100);
    return sku;
  }

  describe('POST /orders', () => {
    const checkout = (token: string, headers = idempotencyKeyHeader()): request.Test =>
      request(server()).post('/orders').set(authHeader(token)).set(headers);

    it('snapshots a cart past one batch from one read per batch', async () => {
      const token = await newPrincipalToken(app);
      const skus: TestProduct[] = [];
      for (let line = 0; line < 150; line += 1) skus.push(await sellable(1_000 + line));
      for (const sku of skus) await addToCart(app, token, sku.variantId, 1);

      const res = await checkout(token);

      expect(res.status).toBe(201);
      expect(res.body.items).toHaveLength(150);
      expect(res.body.totalAmountMinor).toBe(skus.reduce((total, sku) => total + (sku.priceMinor ?? 0), 0));
      const batches = api.requests('skuViews').map(({ body }) => (body as { skuIds: string[] }).skuIds.length);
      expect(batches).toEqual([MAX_SKU_VIEW_BATCH, 150 - MAX_SKU_VIEW_BATCH]);
    });

    it('still refuses an archived SKU with 400', async () => {
      const token = await newPrincipalToken(app);
      const live = await sellable(100_000);
      const archived = await sellable(50_000);
      await addToCart(app, token, live.variantId, 1);
      await addToCart(app, token, archived.variantId, 1);
      await archiveProduct(app, archived.productId);

      const res = await checkout(token);

      expect(res.status).toBe(400);
      expect(res.body.message).toBe(`SKU is not available for order: ${archived.variantId}`);
    });

    it('still refuses an unpriced SKU with 400', async () => {
      const token = await newPrincipalToken(app);
      const live = await sellable(100_000);
      const unpriced = await sellable(50_000);
      await addToCart(app, token, live.variantId, 1);
      await addToCart(app, token, unpriced.variantId, 1);
      await repriceSku(app, unpriced.variantId, null);

      const res = await checkout(token);

      expect(res.status).toBe(400);
      expect(res.body.message).toBe(`SKU is not purchasable (no price): ${unpriced.variantId}`);
      expect(await orderRows()).toEqual([]);
      expect(inventory.calls('try')).toBe(0);
    });

    it('still refuses a line whose SKU left Catalog with 400, naming that line', async () => {
      // Missing SKU first: read by position, the surviving line would absorb its view and checkout
      // would pass with the wrong SKU priced in.
      const token = await newPrincipalToken(app);
      const gone = await sellable(50_000);
      const live = await sellable(100_000);
      await addToCart(app, token, gone.variantId, 1);
      await addToCart(app, token, live.variantId, 1);
      api.removeSku(gone.variantId);

      const res = await checkout(token);

      expect(res.status).toBe(400);
      expect(res.body.message).toBe(`SKU no longer exists in catalog: ${gone.variantId}`);
    });

    // A buyer's own bad cart is an answer from the api, not a fault of it: the breaker must not open
    // on a run of them and take every other buyer's checkout down with it.
    it('keeps the api-internal breaker closed through a run of refused carts', async () => {
      const token = await newPrincipalToken(app);
      const unpriced = await sellable(50_000);
      await addToCart(app, token, unpriced.variantId, 1);
      await repriceSku(app, unpriced.variantId, null);
      for (let attempt = 0; attempt < 6; attempt += 1) await checkout(token).expect(400);

      const buyer = await newPrincipalToken(app);
      const live = await sellable(100_000);
      await addToCart(app, buyer, live.variantId, 1);

      await checkout(buyer).expect(201);
    });
  });

  // An unread cart is not an empty one: the buyer is told to come back, never that there is nothing
  // to buy, and the same key goes through once the api answers again.
  describe.each([
    ['hangs', (stub: ApiInternalStub) => void stub.hang('cartLines')],
    ['answers 404', (stub: ApiInternalStub) => stub.fail('cartLines', 404)],
  ])('POST /orders while the cart read %s', (_fault, inject) => {
    it('answers 503 with Retry-After, writes no order, and succeeds on retry with the same key', async () => {
      const token = await newPrincipalToken(app);
      const sku = await sellable(100_000);
      await addToCart(app, token, sku.variantId, 1);
      const key = idempotencyKeyHeader();
      inject(api);

      const refused = await request(server()).post('/orders').set(authHeader(token)).set(key);

      expect(refused.status).toBe(503);
      expect(refused.headers['retry-after']).toBe('5');
      expect(await orderRows()).toEqual([]);

      api.clearFault('cartLines');
      const placed = await request(server()).post('/orders').set(authHeader(token)).set(key);
      expect(placed.status).toBe(201);
      expect(await orderRows()).toEqual([{ id: placed.body.id }]);
    });
  });
});
