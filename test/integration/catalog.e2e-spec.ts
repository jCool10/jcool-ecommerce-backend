import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PG_POOL } from '../../src/shared/infrastructure/database/drizzle.tokens';
import { authHeader } from '../setup/auth.helper';
import { createTestProduct, seedProducts } from '../setup/fixtures/catalog.fixture';
import { createTestAdmin, createTestUser } from '../setup/fixtures/user.fixture';
import { resetDatabase } from '../setup/reset-database';
import { createTestApp } from '../setup/test-app.factory';

// Black-box HTTP tests for the Catalog context: public read (list pagination +
// detail) and admin CRUD (RBAC + DTO validation) over real Postgres + Redis.
describe('Catalog (integration, real Postgres + Redis)', () => {
  let app: INestApplication;
  let pool: Pool;

  beforeAll(async () => {
    app = await createTestApp();
    pool = app.get<Pool>(PG_POOL);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
  });

  describe('GET /products (list, paginated)', () => {
    it('returns the default page with a correct total (200)', async () => {
      await seedProducts(app, 15);

      const res = await request(app.getHttpServer()).get('/products');

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(15);
      expect(res.body.page).toBe(1);
      expect(res.body.pageSize).toBe(20); // schema default
      expect(res.body.totalPages).toBe(1);
      expect(res.body.items).toHaveLength(15);
    });

    it('slices by page/pageSize without overlap across pages', async () => {
      const { productIds } = await seedProducts(app, 15);

      const page1 = await request(app.getHttpServer()).get('/products').query({ page: 1, pageSize: 10 });
      const page2 = await request(app.getHttpServer()).get('/products').query({ page: 2, pageSize: 10 });

      expect(page1.status).toBe(200);
      expect(page1.body.total).toBe(15);
      expect(page1.body.totalPages).toBe(2);
      expect(page1.body.items).toHaveLength(10);
      expect(page2.body.items).toHaveLength(5);

      // Union of both pages == every seeded product, with no duplicates.
      const seen = [...page1.body.items, ...page2.body.items].map((p: { id: string }) => p.id);
      expect(new Set(seen).size).toBe(15);
      expect(new Set(seen)).toEqual(new Set(productIds));
    });

    it('returns an empty page past the last page (boundary, total unchanged)', async () => {
      await seedProducts(app, 15);

      const res = await request(app.getHttpServer()).get('/products').query({ page: 3, pageSize: 10 });

      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(0);
      expect(res.body.total).toBe(15);
    });

    it('excludes non-ACTIVE products from the list and total', async () => {
      const { categoryId } = await seedProducts(app, 5, { status: 'ACTIVE' });
      await seedProducts(app, 3, { categoryId, status: 'DRAFT' });

      const res = await request(app.getHttpServer()).get('/products');

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(5);
      expect(res.body.items).toHaveLength(5);
    });
  });

  describe('GET /products/:idOrSlug (detail)', () => {
    it('returns the product for an existing id, with its variant + price hydrated (200)', async () => {
      const { productId, sku, priceMinor } = await createTestProduct(app);

      const res = await request(app.getHttpServer()).get(`/products/${productId}`);

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(productId);
      expect(res.body.status).toBe('ACTIVE');
      // Exercises the variant/price left-join — an empty-array pass would hide a broken join.
      expect(res.body.variants.length).toBeGreaterThan(0);
      expect(res.body.variants[0].sku).toBe(sku);
      expect(res.body.variants[0].prices[0].amountMinor).toBe(priceMinor);
    });

    it('returns 404 for a non-existent id', async () => {
      const res = await request(app.getHttpServer()).get('/products/0197c8f4-3a1b-7c2d-8e4f-1a2b3c4d5e6f');
      expect(res.status).toBe(404);
    });
  });

  describe('Admin CRUD (RBAC + validation)', () => {
    async function createCategoryAsAdmin(accessToken: string, slug: string): Promise<string> {
      const res = await request(app.getHttpServer())
        .post('/admin/categories')
        .set(authHeader(accessToken))
        .send({ name: `Category ${slug}`, slug })
        .expect(201);
      return res.body.id as string;
    }

    it('lets an admin create a category then a product (201)', async () => {
      const { accessToken } = await createTestAdmin(app);
      const categoryId = await createCategoryAsAdmin(accessToken, 'admin-electronics');

      const res = await request(app.getHttpServer())
        .post('/admin/products')
        .set(authHeader(accessToken))
        .send({ name: 'Wireless Headphones', slug: 'wireless-headphones', categoryId, status: 'ACTIVE' });

      expect(res.status).toBe(201);
      expect(res.body.id).toBeTruthy();
      expect(res.body).toMatchObject({ name: 'Wireless Headphones', slug: 'wireless-headphones' });
    });

    it('rejects product creation by a non-admin with 403', async () => {
      const { accessToken } = await createTestUser(app); // CUSTOMER
      const res = await request(app.getHttpServer())
        .post('/admin/products')
        .set(authHeader(accessToken))
        .send({ name: 'Nope', slug: 'nope', categoryId: '0197c8f4-3a1b-7c2d-8e4f-1a2b3c4d5e6f' });

      expect(res.status).toBe(403);
    });

    it('rejects product creation with a missing name with 400', async () => {
      const { accessToken } = await createTestAdmin(app);
      const res = await request(app.getHttpServer())
        .post('/admin/products')
        .set(authHeader(accessToken))
        .send({ slug: 'no-name', categoryId: '0197c8f4-3a1b-7c2d-8e4f-1a2b3c4d5e6f' });

      expect(res.status).toBe(400);
    });

    it('rejects a negative price with 400', async () => {
      const { accessToken } = await createTestAdmin(app);
      const res = await request(app.getHttpServer())
        .put('/admin/skus/0197c8f4-3a1b-7c2d-8e4f-1a2b3c4d5e6f/price')
        .set(authHeader(accessToken))
        .send({ amountMinor: -1, currency: 'VND' });

      expect(res.status).toBe(400);
    });

    it('lets an admin update (200) then soft-delete a product (200, archived not hard-deleted)', async () => {
      const { accessToken } = await createTestAdmin(app);
      const categoryId = await createCategoryAsAdmin(accessToken, 'admin-books');

      const created = await request(app.getHttpServer())
        .post('/admin/products')
        .set(authHeader(accessToken))
        .send({ name: 'Draft Book', slug: 'draft-book', categoryId, status: 'ACTIVE' })
        .expect(201);
      const productId = created.body.id as string;

      const updated = await request(app.getHttpServer())
        .patch(`/admin/products/${productId}`)
        .set(authHeader(accessToken))
        .send({ name: 'Published Book' });
      expect(updated.status).toBe(200);
      expect(updated.body.name).toBe('Published Book');

      // Resolves publicly while ACTIVE...
      await request(app.getHttpServer()).get(`/products/${productId}`).expect(200);

      const deleted = await request(app.getHttpServer())
        .delete(`/admin/products/${productId}`)
        .set(authHeader(accessToken));
      expect(deleted.status).toBe(200);
      expect(deleted.body.status).toBe('ARCHIVED'); // soft-delete: archived + echoed, not removed

      // ...and 404s once archived (dropped from the public surface).
      await request(app.getHttpServer()).get(`/products/${productId}`).expect(404);
    });
  });
});
