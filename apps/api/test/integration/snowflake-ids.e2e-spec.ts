import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { decode } from '@jcool/id-codec';
import { authHeader } from '../setup/bearer.helper';
import { createTestCategory } from '../setup/fixtures/catalog.fixture';
import { createTestAdminPrincipal } from '../setup/fixtures/principal.fixture';
import { closeAppAfterAll, createTestAppWithPool, resetDatabaseBeforeEach } from '../setup/harness';
import { STUB_NODE_ID, idServiceStub, testId } from '../setup/id-service-stub';

describe('Snowflake ids (integration, real Postgres + Redis)', () => {
  let app: INestApplication;
  let pool: Pool;

  beforeAll(async () => {
    ({ app, pool } = await createTestAppWithPool());
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);
  afterEach(async () => (await idServiceStub()).reset());

  // The stub's node, not just a routable id: an id minted anywhere but the id-service fails here.
  const expectMintedIds = async (sql: string, params: unknown[] = []): Promise<void> => {
    const { rows } = await pool.query<{ id: string }>(sql, params);
    expect(rows.length).toBeGreaterThan(0);
    for (const { id } of rows) expect(decode(id).nodeId, id).toBe(STUB_NODE_ID);
  };

  it('mints catalog ids through the id-service', async () => {
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

    for (const table of ['categories', 'products', 'product_variants', 'prices', 'outbox']) {
      await expectMintedIds(`SELECT id FROM ${table}`);
    }
  });

  it('refuses a uuid where an id belongs, and 404s a routable id nobody minted', async () => {
    const { accessToken } = await createTestAdminPrincipal(app);
    const rename = (skuId: string) =>
      request(app.getHttpServer()).patch(`/admin/skus/${skuId}`).set(authHeader(accessToken)).send({ name: 'Renamed' });

    await rename(randomUUID()).expect(400);
    await rename(testId()).expect(404);
    await request(app.getHttpServer())
      .post('/admin/products')
      .set(authHeader(accessToken))
      .send({ name: 'Uuid category', slug: 'uuid-category', categoryId: randomUUID() })
      .expect(400);
  });

  it('answers 503 and writes nothing when the id service cannot mint', async () => {
    const { id: categoryId } = await createTestCategory(app);
    const { accessToken } = await createTestAdminPrincipal(app);
    (await idServiceStub()).fail(503);

    await request(app.getHttpServer())
      .post('/admin/products')
      .set(authHeader(accessToken))
      .send({ name: 'Unminted', slug: 'unminted', categoryId })
      .expect(503);

    expect((await pool.query('SELECT 1 FROM products')).rows).toEqual([]);
    expect((await pool.query('SELECT 1 FROM outbox')).rows).toEqual([]);
  });
});
