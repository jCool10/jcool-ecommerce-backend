import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MAX_CART_LINES, MAX_LINE_QUANTITY } from '../../src/modules/cart/cart.constants';
import { DrizzleCatalogSkuViewRepository } from '../../src/modules/catalog/infrastructure/drizzle-catalog-sku-view.repository';
import { authHeader } from '../setup/bearer.helper';
import {
  archiveProduct,
  createTestProduct,
  dropSkuView,
  repriceSku,
  type TestProduct,
} from '../setup/fixtures/catalog.fixture';
import { addToCart } from '../setup/fixtures/order-flow.fixture';
import { newPrincipalToken } from '../setup/fixtures/principal.fixture';
import { closeAppAfterAll, createTestAppWithPool, resetDatabaseBeforeEach } from '../setup/harness';
import { testId } from '../setup/id-service-stub';

const ABSENT_ID = testId();

type CartLine = Record<string, unknown> & { skuId: string };

// The api's /cart contract, served here and priced from the catalog read model.
describe('Cart (integration, real Postgres + Redis)', () => {
  let app: INestApplication;
  let pool: Pool;

  beforeAll(async () => {
    ({ app, pool } = await createTestAppWithPool());
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const server = () => app.getHttpServer();
  const add = (token: string, skuId: string, quantity: number) =>
    request(server()).post('/cart/items').set(authHeader(token)).send({ skuId, quantity });
  const view = (token: string) => request(server()).get('/cart').set(authHeader(token));
  const linesBySku = (body: { items: CartLine[] }) => new Map(body.items.map((line) => [line.skuId, line]));
  const cartCount = async () => (await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM carts')).rows[0].n;

  describe('GET /cart', () => {
    it('shows an empty VND cart to a buyer who has none, without creating one', async () => {
      const token = await newPrincipalToken(app);

      const res = await view(token).expect(200);

      expect(res.body).toEqual({ items: [], subtotalMinor: 0, currency: 'VND' });
      expect(await cartCount()).toBe(0);
    });

    it('sums the subtotal from live prices across lines', async () => {
      const token = await newPrincipalToken(app);
      const a = await createTestProduct(app, { priceMinor: 199_000, name: 'Linen shirt' });
      const b = await createTestProduct(app, { priceMinor: 50_000 });
      await addToCart(app, token, a.variantId, 2);
      await addToCart(app, token, b.variantId, 1);

      const res = await view(token).expect(200);

      expect(res.body.items).toEqual([
        {
          skuId: a.variantId,
          productName: 'Linen shirt',
          quantity: 2,
          unitPriceMinor: 199_000,
          lineTotalMinor: 398_000,
          isActive: true,
        },
        expect.objectContaining({ skuId: b.variantId, quantity: 1, lineTotalMinor: 50_000 }),
      ]);
      expect(res.body.subtotalMinor).toBe(199_000 * 2 + 50_000);
      expect(res.body.currency).toBe('VND');
    });

    it('keeps an archived line priced and counted, flagged inactive, and an unpriced one out of the subtotal', async () => {
      const token = await newPrincipalToken(app);
      const live = await createTestProduct(app, { priceMinor: 100_000 });
      const archived = await createTestProduct(app, { priceMinor: 50_000 });
      const unpriced = await createTestProduct(app, { priceMinor: 70_000 });
      await addToCart(app, token, live.variantId, 2);
      await addToCart(app, token, archived.variantId, 1);
      await addToCart(app, token, unpriced.variantId, 3);
      await archiveProduct(app, archived.productId);
      await repriceSku(app, unpriced.variantId, null);

      const res = await view(token).expect(200);

      const bySku = linesBySku(res.body);
      expect(bySku.get(live.variantId)).toMatchObject({
        unitPriceMinor: 100_000,
        lineTotalMinor: 200_000,
        isActive: true,
      });
      expect(bySku.get(archived.variantId)).toMatchObject({ unitPriceMinor: 50_000, isActive: false });
      expect(bySku.get(unpriced.variantId)).toMatchObject({
        unitPriceMinor: null,
        lineTotalMinor: null,
        isActive: true,
      });
      expect(res.body.subtotalMinor).toBe(200_000 + 50_000);
    });

    // The missing SKU is the first line: views matched by position would slide every later line onto the wrong price.
    it('keys every line to its own SKU when an earlier one left the read model', async () => {
      const token = await newPrincipalToken(app);
      const gone = await createTestProduct(app, { priceMinor: 40_000 });
      const first = await createTestProduct(app, { priceMinor: 100_000 });
      const second = await createTestProduct(app, { priceMinor: 7_000 });
      await addToCart(app, token, gone.variantId, 5);
      await addToCart(app, token, first.variantId, 1);
      await addToCart(app, token, second.variantId, 2);
      await dropSkuView(app, gone.variantId);

      const res = await view(token).expect(200);

      expect(res.body.items.map((line: CartLine) => line.skuId)).toEqual([
        gone.variantId,
        first.variantId,
        second.variantId,
      ]);
      const bySku = linesBySku(res.body);
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

    it('shows a reprice on the next read', async () => {
      const token = await newPrincipalToken(app);
      const { variantId } = await createTestProduct(app, { priceMinor: 100_000 });
      await addToCart(app, token, variantId, 2);

      await repriceSku(app, variantId, 150_000);

      const res = await view(token).expect(200);
      expect(res.body.items[0].unitPriceMinor).toBe(150_000);
      expect(res.body.subtotalMinor).toBe(300_000);
    });

    it('prices a full cart from one read of the read model', async () => {
      const token = await newPrincipalToken(app);
      const skus: TestProduct[] = [];
      for (let line = 0; line < MAX_CART_LINES; line += 1)
        skus.push(await createTestProduct(app, { priceMinor: 1_000 }));
      for (const sku of skus) await addToCart(app, token, sku.variantId, 2);
      const readModel = app.get(DrizzleCatalogSkuViewRepository);
      const batched = vi.spyOn(readModel, 'getSkuViews');
      const single = vi.spyOn(readModel, 'getSkuView');

      const res = await view(token).expect(200);

      expect(res.body.items).toHaveLength(MAX_CART_LINES);
      expect(res.body.subtotalMinor).toBe(MAX_CART_LINES * 1_000 * 2);
      expect(batched).toHaveBeenCalledTimes(1);
      expect(single).not.toHaveBeenCalled();
    });
  });

  describe('POST /cart/items', () => {
    it('adds a SKU at its live price and answers 200 with the cart', async () => {
      const token = await newPrincipalToken(app);
      const { variantId } = await createTestProduct(app, { priceMinor: 199_000 });

      const res = await add(token, variantId, 2).expect(200);

      expect(res.body.items).toEqual([
        expect.objectContaining({
          skuId: variantId,
          quantity: 2,
          unitPriceMinor: 199_000,
          lineTotalMinor: 398_000,
          isActive: true,
        }),
      ]);
      expect(res.body.subtotalMinor).toBe(398_000);
    });

    it('accumulates a repeat SKU onto its line', async () => {
      const token = await newPrincipalToken(app);
      const { variantId } = await createTestProduct(app, { priceMinor: 100_000 });

      await add(token, variantId, 2).expect(200);
      const res = await add(token, variantId, 3).expect(200);

      expect(res.body.items).toEqual([expect.objectContaining({ skuId: variantId, quantity: 5 })]);
      expect(res.body.subtotalMinor).toBe(500_000);
    });

    it('clamps a line at the per-line cap across repeated adds', async () => {
      const token = await newPrincipalToken(app);
      const { variantId } = await createTestProduct(app);

      await add(token, variantId, MAX_LINE_QUANTITY).expect(200);
      const res = await add(token, variantId, 1).expect(200);

      expect(res.body.items).toEqual([expect.objectContaining({ skuId: variantId, quantity: MAX_LINE_QUANTITY })]);
    });

    it('keeps one cart with both lines when a buyer without one adds two SKUs at once', async () => {
      const token = await newPrincipalToken(app);
      const first = await createTestProduct(app);
      const second = await createTestProduct(app);

      await Promise.all([add(token, first.variantId, 1).expect(200), add(token, second.variantId, 2).expect(200)]);

      const res = await view(token).expect(200);
      const lines = linesBySku(res.body);
      expect(lines.get(first.variantId)).toEqual(expect.objectContaining({ quantity: 1 }));
      expect(lines.get(second.variantId)).toEqual(expect.objectContaining({ quantity: 2 }));
      expect(res.body.items).toHaveLength(2);
      expect(await cartCount()).toBe(1);
    });

    it('rejects a zero, negative, fractional or over-cap quantity and a non-id SKU with 400', async () => {
      const token = await newPrincipalToken(app);
      const { variantId } = await createTestProduct(app);

      const statuses: number[] = [];
      for (const body of [
        { skuId: variantId, quantity: 0 },
        { skuId: variantId, quantity: -3 },
        { skuId: variantId, quantity: 1.5 },
        { skuId: variantId, quantity: MAX_LINE_QUANTITY + 1 },
        { skuId: 'not-an-id', quantity: 1 },
        { skuId: variantId, quantity: 1, price: 1 },
      ]) {
        statuses.push((await request(server()).post('/cart/items').set(authHeader(token)).send(body)).status);
      }

      expect(statuses).toEqual([400, 400, 400, 400, 400, 400]);
      expect(await cartCount()).toBe(0);
    });

    it('answers 404 for a SKU the read model does not hold, and for a DRAFT or archived one', async () => {
      const token = await newPrincipalToken(app);
      const draft = await createTestProduct(app, { status: 'DRAFT' });
      const archived = await createTestProduct(app, { status: 'ARCHIVED' });

      for (const skuId of [ABSENT_ID, draft.variantId, archived.variantId]) {
        const res = await add(token, skuId, 1);
        expect(res.status, skuId).toBe(404);
        expect(res.body.message).toBe(`SKU not found: ${skuId}`);
        expect(JSON.stringify(res.body)).not.toContain(draft.name);
      }
      expect(await cartCount()).toBe(0);
    });

    it('refuses a new distinct SKU past the line cap with 422, yet still accumulates onto an existing line', async () => {
      const token = await newPrincipalToken(app);
      const skus: TestProduct[] = [];
      for (let line = 0; line <= MAX_CART_LINES; line += 1) skus.push(await createTestProduct(app));
      for (const sku of skus.slice(0, MAX_CART_LINES)) await addToCart(app, token, sku.variantId, 1);

      await add(token, skus[MAX_CART_LINES].variantId, 1).expect(422);
      const res = await add(token, skus[0].variantId, 1).expect(200);

      expect(res.body.items).toHaveLength(MAX_CART_LINES);
      expect(linesBySku(res.body).get(skus[0].variantId)).toMatchObject({ quantity: 2 });
    });
  });

  describe('PATCH /cart/items/:skuId', () => {
    it('sets a line to an absolute quantity', async () => {
      const token = await newPrincipalToken(app);
      const { variantId } = await createTestProduct(app, { priceMinor: 100_000 });
      await addToCart(app, token, variantId, 2);

      const res = await request(server())
        .patch(`/cart/items/${variantId}`)
        .set(authHeader(token))
        .send({ quantity: 5 })
        .expect(200);

      expect(res.body.items[0].quantity).toBe(5);
      expect(res.body.subtotalMinor).toBe(500_000);
    });

    it('answers 404 for a SKU that is not in the cart', async () => {
      const token = await newPrincipalToken(app);
      const { variantId } = await createTestProduct(app);
      const other = await createTestProduct(app);
      await addToCart(app, token, other.variantId, 1);

      await request(server())
        .patch(`/cart/items/${variantId}`)
        .set(authHeader(token))
        .send({ quantity: 3 })
        .expect(404);
    });

    it('answers 400 for a quantity past the cap and for a path that is not an id', async () => {
      const token = await newPrincipalToken(app);
      const { variantId } = await createTestProduct(app);
      await addToCart(app, token, variantId, 1);

      await request(server())
        .patch(`/cart/items/${variantId}`)
        .set(authHeader(token))
        .send({ quantity: MAX_LINE_QUANTITY + 1 })
        .expect(400);
      await request(server()).patch('/cart/items/not-an-id').set(authHeader(token)).send({ quantity: 1 }).expect(400);
    });
  });

  describe('DELETE /cart/items/:skuId', () => {
    it('removes one line', async () => {
      const token = await newPrincipalToken(app);
      const a = await createTestProduct(app);
      const b = await createTestProduct(app);
      await addToCart(app, token, a.variantId, 1);
      await addToCart(app, token, b.variantId, 1);

      const res = await request(server()).delete(`/cart/items/${a.variantId}`).set(authHeader(token)).expect(200);

      expect(res.body.items).toEqual([expect.objectContaining({ skuId: b.variantId })]);
    });

    it('answers 200 for a line that is not there', async () => {
      const token = await newPrincipalToken(app);

      const res = await request(server()).delete(`/cart/items/${ABSENT_ID}`).set(authHeader(token)).expect(200);

      expect(res.body.items).toEqual([]);
    });
  });

  describe('DELETE /cart', () => {
    it('clears every line', async () => {
      const token = await newPrincipalToken(app);
      const a = await createTestProduct(app);
      const b = await createTestProduct(app);
      await addToCart(app, token, a.variantId, 1);
      await addToCart(app, token, b.variantId, 1);

      const res = await request(server()).delete('/cart').set(authHeader(token)).expect(200);

      expect(res.body).toEqual({ items: [], subtotalMinor: 0, currency: 'VND' });
    });
  });

  it('never creates a cart for a buyer who has none on PATCH, DELETE or clear', async () => {
    const token = await newPrincipalToken(app);

    await request(server()).patch(`/cart/items/${ABSENT_ID}`).set(authHeader(token)).send({ quantity: 2 }).expect(404);
    await request(server()).delete(`/cart/items/${ABSENT_ID}`).set(authHeader(token)).expect(200);
    await request(server()).delete('/cart').set(authHeader(token)).expect(200);

    expect(await cartCount()).toBe(0);
  });

  it("keeps one buyer's lines out of another buyer's cart", async () => {
    const tokenA = await newPrincipalToken(app);
    const tokenB = await newPrincipalToken(app);
    const { variantId } = await createTestProduct(app);
    await addToCart(app, tokenA, variantId, 1);

    await request(server()).delete(`/cart/items/${variantId}`).set(authHeader(tokenB)).expect(200);
    await request(server()).patch(`/cart/items/${variantId}`).set(authHeader(tokenB)).send({ quantity: 3 }).expect(404);

    expect((await view(tokenA).expect(200)).body.items).toEqual([
      expect.objectContaining({ skuId: variantId, quantity: 1 }),
    ]);
    expect((await view(tokenB).expect(200)).body.items).toEqual([]);
  });

  it('answers 401 without a token', async () => {
    await request(server()).get('/cart').expect(401);
    await request(server()).post('/cart/items').send({ skuId: ABSENT_ID, quantity: 1 }).expect(401);
  });
});
