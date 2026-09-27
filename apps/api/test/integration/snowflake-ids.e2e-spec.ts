import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { bucketOf, isRoutableId } from '@jcool/id-codec';
import { authHeader } from '../setup/bearer.helper';
import { addToCart, checkout, openSession, seedSellableSku } from '../setup/fixtures/order-flow.fixture';
import { createTestAdminPrincipal, createTestPrincipal } from '../setup/fixtures/principal.fixture';
import { createTestAppWithFakeGateway, closeAppAfterAll, resetDatabaseBeforeEach } from '../setup/harness';
import { idServiceStub, testId } from '../setup/id-service-stub';

const UNOWNED = 0;

describe('Snowflake ids (integration, real Postgres + Redis)', () => {
  let app: INestApplication;
  let pool: Pool;

  beforeAll(async () => {
    ({ app, pool } = await createTestAppWithFakeGateway('whsec_snowflake_ids_e2e_000000'));
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);
  afterEach(async () => (await idServiceStub()).reset());

  const bucketsOf = async (sql: string, params: unknown[] = []): Promise<number[]> => {
    const { rows } = await pool.query<{ id: string }>(sql, params);
    expect(rows.length).toBeGreaterThan(0);
    for (const { id } of rows) expect(isRoutableId(id), id).toBe(true);
    return [...new Set(rows.map(({ id }) => bucketOf(id)))];
  };

  it("keeps a buyer's cart, order and everything under the order in the buyer's bucket", async () => {
    const sku = await seedSellableSku(app, { onHand: 5 });
    const { user, accessToken } = await createTestPrincipal(app);
    const buyer = bucketOf(user.id);

    await addToCart(app, accessToken, sku.variantId, 2);
    const order = await checkout(app, accessToken).expect(201);
    const orderId = order.body.id as string;
    await openSession(app, accessToken, orderId).expect(201);

    expect(bucketOf(orderId)).toBe(buyer);
    expect(await bucketsOf('SELECT id FROM carts')).toEqual([buyer]);
    expect(await bucketsOf('SELECT id FROM cart_items')).toEqual([buyer]);
    expect(await bucketsOf('SELECT id FROM order_items WHERE order_id = $1', [orderId])).toEqual([buyer]);
    expect(await bucketsOf('SELECT id FROM reservations WHERE order_id = $1', [orderId])).toEqual([buyer]);
    expect(await bucketsOf('SELECT id FROM payments WHERE order_id = $1', [orderId])).toEqual([buyer]);
    expect(await bucketsOf('SELECT id FROM idempotency_keys')).toEqual([buyer]);
    expect(await bucketsOf('SELECT id FROM outbox')).toEqual([UNOWNED]);
  });

  it('mints catalog and stock ids in the unowned bucket', async () => {
    const admin = await createTestAdminPrincipal(app);
    const http = () => request(app.getHttpServer());
    const auth = authHeader(admin.accessToken);

    const category = await http().post('/admin/categories').set(auth).send({ name: 'Ids', slug: 'ids' }).expect(201);
    const product = await http()
      .post('/admin/products')
      .set(auth)
      .send({ name: 'Id product', slug: 'id-product', categoryId: category.body.id })
      .expect(201);
    const sku = await http()
      .post(`/admin/products/${product.body.id}/skus`)
      .set(auth)
      .send({ sku: 'ID-SKU-1', name: 'Default' })
      .expect(201);
    await http().put(`/admin/skus/${sku.body.id}/price`).set(auth).send({ amountMinor: 10_000 }).expect(200);
    await http().put(`/admin/inventory/${sku.body.id}`).set(auth).send({ quantityOnHand: 3 }).expect(200);

    for (const table of ['categories', 'products', 'product_variants', 'prices', 'stock_levels', 'outbox']) {
      expect(await bucketsOf(`SELECT id FROM ${table}`), table).toEqual([UNOWNED]);
    }
  });

  it('refuses a uuid where an id belongs, and 404s a routable id nobody minted', async () => {
    const { accessToken } = await createTestPrincipal(app);
    const unknown = testId();

    await request(app.getHttpServer()).get(`/orders/${randomUUID()}`).set(authHeader(accessToken)).expect(400);
    await request(app.getHttpServer()).get(`/orders/${unknown}`).set(authHeader(accessToken)).expect(404);
    await request(app.getHttpServer())
      .post('/cart/items')
      .set(authHeader(accessToken))
      .send({ skuId: randomUUID(), quantity: 1 })
      .expect(400);
  });

  it('answers 503 and writes nothing when the id service cannot mint', async () => {
    const sku = await seedSellableSku(app, { onHand: 5 });
    const { accessToken } = await createTestPrincipal(app);
    (await idServiceStub()).fail(503);

    await request(app.getHttpServer())
      .post('/cart/items')
      .set(authHeader(accessToken))
      .send({ skuId: sku.variantId, quantity: 1 })
      .expect(503);

    const { rows } = await pool.query('SELECT 1 FROM cart_items');
    expect(rows).toEqual([]);
  });
});
