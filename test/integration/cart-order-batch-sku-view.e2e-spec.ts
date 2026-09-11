import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DrizzleProductRepository } from '../../src/modules/catalog/infrastructure/drizzle-product.repository';
import type { DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import { authHeader } from '../setup/auth.helper';
import { archiveProduct, createTestProduct, type TestProduct } from '../setup/fixtures/catalog.fixture';
import { seedStock } from '../setup/fixtures/inventory.fixture';
import { addToCart } from '../setup/fixtures/order-flow.fixture';
import { newUserToken } from '../setup/fixtures/user.fixture';
import { closeAppAfterAll, createTestAppWithPool, resetDatabaseBeforeEach } from '../setup/harness';
import { idempotencyKeyHeader } from '../setup/idempotency.helper';

// A syntactically-valid UUID no fixture creates, so probing it exercises "absent" and not a cast error.
const ABSENT_UUID = '00000000-0000-4000-8000-000000000000';

/**
 * Cart and Order price a whole cart through Catalog's published port in ONE read. Neither claim is
 * visible from a response body alone: that the read really collapses to a single query, and that
 * every per-line semantic survives the fold — including the ones that used to ride on array position.
 */
describe('Batch SKU view (integration, real Postgres + Redis)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;
  let repo: DrizzleProductRepository;

  beforeAll(async () => {
    ({ app, pool, db } = await createTestAppWithPool());
    // The source adapter, not the cache in front of it: the SKU reads pass straight through, and
    // this is where "one query" is decided.
    repo = app.get(DrizzleProductRepository);
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const server = () => app.getHttpServer();

  async function unprice(variantId: string): Promise<void> {
    await db.delete(schema.prices).where(eq(schema.prices.variantId, variantId));
  }

  // Drops the SKU out of Catalog entirely. `cart_items` has no FK to `product_variants` (the
  // boundary is application-level), so the cart line outlives its own SKU — the case a real purge
  // produces, and the one a positional batch result would silently mis-align.
  async function deleteSku(variantId: string): Promise<void> {
    await unprice(variantId);
    await db.delete(schema.productVariants).where(eq(schema.productVariants.id, variantId));
  }

  describe('findManySkuViews', () => {
    it('reads every id in a single round-trip', async () => {
      const skus = [await createTestProduct(app), await createTestProduct(app), await createTestProduct(app)];
      const query = vi.spyOn(pool, 'query');

      const views = await repo.findManySkuViews(skus.map((sku) => sku.variantId));

      expect(query).toHaveBeenCalledTimes(1);
      expect(views.map((view) => view.skuId).sort()).toEqual(skus.map((sku) => sku.variantId).sort());
    });

    it('costs no round-trip when there is nothing to read', async () => {
      const query = vi.spyOn(pool, 'query');

      await expect(repo.findManySkuViews([])).resolves.toEqual([]);

      expect(query).not.toHaveBeenCalled();
    });

    it('omits an id Catalog does not know instead of padding the result', async () => {
      const { variantId } = await createTestProduct(app);

      const views = await repo.findManySkuViews([variantId, ABSENT_UUID]);

      expect(views).toHaveLength(1);
      expect(views[0].skuId).toBe(variantId);
    });

    it('returns exactly what findSkuView returns, priced or not, live or archived', async () => {
      const live = await createTestProduct(app, { priceMinor: 123_000 });
      const dead = await createTestProduct(app);
      await unprice(dead.variantId);
      await archiveProduct(app, dead.productId);

      const batched = await repo.findManySkuViews([live.variantId, dead.variantId]);
      const [oneLive, oneDead] = await Promise.all([
        repo.findSkuView(live.variantId),
        repo.findSkuView(dead.variantId),
      ]);

      const bySku = new Map(batched.map((view) => [view.skuId, view]));
      expect(bySku.get(live.variantId)).toEqual(oneLive);
      expect(bySku.get(dead.variantId)).toEqual(oneDead);
    });
  });

  describe('GET /cart', () => {
    it('resolves the whole cart with one Catalog read, whatever the line count', async () => {
      const token = await newUserToken(app);
      const skus: TestProduct[] = [];
      for (let i = 0; i < 12; i++) {
        skus.push(await createTestProduct(app, { priceMinor: 1_000 }));
      }
      for (const sku of skus) {
        await addToCart(app, token, sku.variantId, 2);
      }

      const batched = vi.spyOn(repo, 'findManySkuViews');
      const single = vi.spyOn(repo, 'findSkuView');

      const res = await request(server()).get('/cart').set(authHeader(token));

      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(12);
      expect(res.body.subtotalMinor).toBe(12 * 1_000 * 2);
      expect(batched).toHaveBeenCalledTimes(1);
      expect(single).not.toHaveBeenCalled();
    });

    it('keeps per-line price and isActive across a mixed cart', async () => {
      const token = await newUserToken(app);
      const live = await createTestProduct(app, { priceMinor: 100_000 });
      const archived = await createTestProduct(app, { priceMinor: 50_000 });
      const unpriced = await createTestProduct(app, { priceMinor: 70_000 });
      await addToCart(app, token, live.variantId, 2);
      await addToCart(app, token, archived.variantId, 1);
      await addToCart(app, token, unpriced.variantId, 3);
      await archiveProduct(app, archived.productId);
      await unprice(unpriced.variantId);

      const res = await request(server()).get('/cart').set(authHeader(token));

      expect(res.status).toBe(200);
      const bySku = new Map<string, Record<string, unknown>>(
        (res.body.items as Record<string, unknown>[]).map((line) => [line.skuId as string, line]),
      );
      expect(bySku.get(live.variantId)).toMatchObject({
        unitPriceMinor: 100_000,
        lineTotalMinor: 200_000,
        isActive: true,
      });
      // Archived after it was added: still priced, still counted, only flagged.
      expect(bySku.get(archived.variantId)).toMatchObject({ unitPriceMinor: 50_000, isActive: false });
      expect(bySku.get(unpriced.variantId)).toMatchObject({
        unitPriceMinor: null,
        lineTotalMinor: null,
        isActive: true,
      });
      expect(res.body.subtotalMinor).toBe(200_000 + 50_000);
    });

    it('keys every line to its own SKU when an earlier line has left Catalog', async () => {
      // The missing SKU is the FIRST line on purpose: a batch result read by position would slide
      // every later line onto the wrong view, which lands as a wrong price rather than an error.
      const token = await newUserToken(app);
      const gone = await createTestProduct(app, { priceMinor: 40_000 });
      const first = await createTestProduct(app, { priceMinor: 100_000 });
      const second = await createTestProduct(app, { priceMinor: 7_000 });
      await addToCart(app, token, gone.variantId, 5);
      await addToCart(app, token, first.variantId, 1);
      await addToCart(app, token, second.variantId, 2);
      await deleteSku(gone.variantId);

      const res = await request(server()).get('/cart').set(authHeader(token));

      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(3);
      const bySku = new Map<string, Record<string, unknown>>(
        (res.body.items as Record<string, unknown>[]).map((line) => [line.skuId as string, line]),
      );
      expect(bySku.get(gone.variantId)).toMatchObject({
        productName: '',
        unitPriceMinor: null,
        lineTotalMinor: null,
        isActive: false,
      });
      expect(bySku.get(first.variantId)).toMatchObject({ unitPriceMinor: 100_000, lineTotalMinor: 100_000 });
      expect(bySku.get(second.variantId)).toMatchObject({ unitPriceMinor: 7_000, lineTotalMinor: 14_000 });
      expect(res.body.subtotalMinor).toBe(100_000 + 14_000);
    });
  });

  describe('POST /orders', () => {
    async function sellable(priceMinor: number): Promise<TestProduct> {
      const sku = await createTestProduct(app, { priceMinor });
      await seedStock(app, sku.variantId, 100);
      return sku;
    }

    const checkout = (token: string): request.Test =>
      request(server()).post('/orders').set(authHeader(token)).set(idempotencyKeyHeader());

    it('snapshots a multi-line order from one Catalog read', async () => {
      const token = await newUserToken(app);
      const a = await sellable(100_000);
      const b = await sellable(25_000);
      await addToCart(app, token, a.variantId, 2);
      await addToCart(app, token, b.variantId, 3);

      const batched = vi.spyOn(repo, 'findManySkuViews');
      const single = vi.spyOn(repo, 'findSkuView');

      const res = await checkout(token);

      expect(res.status).toBe(201);
      expect(res.body.items).toHaveLength(2);
      expect(res.body.totalAmountMinor).toBe(100_000 * 2 + 25_000 * 3);
      expect(batched).toHaveBeenCalledTimes(1);
      expect(single).not.toHaveBeenCalled();
    });

    it('still refuses an archived SKU with 400', async () => {
      const token = await newUserToken(app);
      const live = await sellable(100_000);
      const archived = await sellable(50_000);
      await addToCart(app, token, live.variantId, 1);
      await addToCart(app, token, archived.variantId, 1);
      await archiveProduct(app, archived.productId);

      const res = await checkout(token);

      expect(res.status).toBe(400);
      expect(res.body.message).toContain(archived.variantId);
    });

    it('still refuses an unpriced SKU with 400', async () => {
      const token = await newUserToken(app);
      const live = await sellable(100_000);
      const unpriced = await sellable(50_000);
      await addToCart(app, token, live.variantId, 1);
      await addToCart(app, token, unpriced.variantId, 1);
      await unprice(unpriced.variantId);

      const res = await checkout(token);

      expect(res.status).toBe(400);
      expect(res.body.message).toContain(unpriced.variantId);
    });

    it('still refuses a line whose SKU left Catalog with 400, naming that line', async () => {
      // Missing SKU first again: read by position, the surviving line would absorb its view and
      // checkout would pass with the wrong SKU priced in.
      const token = await newUserToken(app);
      const gone = await sellable(50_000);
      const live = await sellable(100_000);
      await addToCart(app, token, gone.variantId, 1);
      await addToCart(app, token, live.variantId, 1);
      await deleteSku(gone.variantId);

      const res = await checkout(token);

      expect(res.status).toBe(400);
      expect(res.body.message).toContain(gone.variantId);
    });
  });
});
