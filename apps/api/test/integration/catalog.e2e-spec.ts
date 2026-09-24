import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { authHeader } from '../setup/bearer.helper';
import {
  archiveTestCategory,
  createTestCategory,
  createTestProduct,
  seedProducts,
} from '../setup/fixtures/catalog.fixture';
import { createTestAdminPrincipal } from '../setup/fixtures/principal.fixture';
import { closeAppAfterAll, createTestAppWithPool } from '../setup/harness';
import { resetCatalogCache } from '../setup/reset-cache';
import { resetDatabase } from '../setup/reset-database';

const ABSENT_UUID = '0197c8f4-3a1b-7c2d-8e4f-1a2b3c4d5e6f';

describe('Catalog (integration, real Postgres + Redis)', () => {
  let app: INestApplication;
  let pool: Pool;

  beforeAll(async () => {
    ({ app, pool } = await createTestAppWithPool());
  });
  closeAppAfterAll(() => app);

  // The generation bump after the truncate keeps the previous test's rows out of Redis.
  beforeEach(async () => {
    await resetDatabase(pool);
    await resetCatalogCache(app);
  });

  describe('GET /products (list, paginated)', () => {
    it('returns the default page with a correct total', async () => {
      await seedProducts(app, 15);

      const res = await request(app.getHttpServer()).get('/products');

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ total: 15, page: 1, pageSize: 20, totalPages: 1 });
      expect(res.body.items).toHaveLength(15);
    });

    it('serves the last page inside the ceiling and rejects the next with 400', async () => {
      const last = await request(app.getHttpServer()).get('/products').query({ page: 10_000 });
      const past = await request(app.getHttpServer()).get('/products').query({ page: 10_001 });

      expect(last.status).toBe(200);
      expect(last.body.items).toEqual([]);
      expect(past.status).toBe(400);
    });

    it('rejects a malformed categorySlug and serves an unknown one as empty', async () => {
      const malformed = await request(app.getHttpServer()).get('/products').query({ categorySlug: 'Not A Slug!' });
      const unknown = await request(app.getHttpServer()).get('/products').query({ categorySlug: 'no-such-category' });

      expect(malformed.status).toBe(400);
      expect(unknown.status).toBe(200);
      expect(unknown.body.items).toEqual([]);
    });

    it('filters to the requested category and excludes every other one', async () => {
      const category = await createTestCategory(app);
      await seedProducts(app, 3, { categoryId: category.id });
      await seedProducts(app, 2);

      const res = await request(app.getHttpServer()).get('/products').query({ categorySlug: category.slug });

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(3);
      expect(res.body.items).toHaveLength(3);
    });

    it('hides live products under an archived category, filtered by slug or not', async () => {
      const category = await createTestCategory(app);
      await seedProducts(app, 3, { categoryId: category.id });
      await archiveTestCategory(app, category.id);

      const filtered = await request(app.getHttpServer()).get('/products').query({ categorySlug: category.slug });
      const unfiltered = await request(app.getHttpServer()).get('/products');

      expect(filtered.status).toBe(200);
      expect(filtered.body.items).toEqual([]);
      expect(filtered.body.total).toBe(0);
      expect(unfiltered.body.items).toEqual([]);
      expect(unfiltered.body.total).toBe(0);
    });

    it('slices by page and pageSize without overlap across pages', async () => {
      const { productIds } = await seedProducts(app, 15);

      const page1 = await request(app.getHttpServer()).get('/products').query({ page: 1, pageSize: 10 });
      const page2 = await request(app.getHttpServer()).get('/products').query({ page: 2, pageSize: 10 });

      expect(page1.status).toBe(200);
      expect(page1.body.total).toBe(15);
      expect(page1.body.totalPages).toBe(2);
      expect(page1.body.items).toHaveLength(10);
      expect(page2.body.items).toHaveLength(5);

      const seen = [...page1.body.items, ...page2.body.items].map((p: { id: string }) => p.id);
      expect(new Set(seen).size).toBe(15);
      expect(new Set(seen)).toEqual(new Set(productIds));
    });

    it('returns an empty page past the last page with the total unchanged', async () => {
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
    it('returns the product by id with its variant and price', async () => {
      const { productId, sku, priceMinor } = await createTestProduct(app);

      const res = await request(app.getHttpServer()).get(`/products/${productId}`);

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(productId);
      expect(res.body.status).toBe('ACTIVE');
      expect(res.body.variants.length).toBeGreaterThan(0);
      expect(res.body.variants[0].sku).toBe(sku);
      expect(res.body.variants[0].prices[0].amountMinor).toBe(priceMinor);
    });

    it('resolves the product by slug', async () => {
      const { productId, slug } = await createTestProduct(app);

      const res = await request(app.getHttpServer()).get(`/products/${slug}`);

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(productId);
      expect(res.body.slug).toBe(slug);
    });

    it('returns 404 for an unknown id and an unknown slug', async () => {
      await request(app.getHttpServer()).get(`/products/${ABSENT_UUID}`).expect(404);
      await request(app.getHttpServer()).get('/products/no-such-slug').expect(404);
    });
  });

  describe('admin writes', () => {
    it('rejects product creation with a missing name with 400', async () => {
      const { accessToken } = await createTestAdminPrincipal(app);
      const res = await request(app.getHttpServer())
        .post('/admin/products')
        .set(authHeader(accessToken))
        .send({ slug: 'no-name', categoryId: ABSENT_UUID });

      expect(res.status).toBe(400);
    });

    it('rejects a malformed product id with 400', async () => {
      const { accessToken } = await createTestAdminPrincipal(app);
      const res = await request(app.getHttpServer())
        .patch('/admin/products/not-a-uuid')
        .set(authHeader(accessToken))
        .send({ name: 'x' });

      expect(res.status).toBe(400);
    });

    it('rejects a negative price with 400', async () => {
      const { accessToken } = await createTestAdminPrincipal(app);
      const res = await request(app.getHttpServer())
        .put(`/admin/skus/${ABSENT_UUID}/price`)
        .set(authHeader(accessToken))
        .send({ amountMinor: -1, currency: 'VND' });

      expect(res.status).toBe(400);
    });

    it('updates a product, then archives it instead of deleting it', async () => {
      const { accessToken } = await createTestAdminPrincipal(app);
      const category = await request(app.getHttpServer())
        .post('/admin/categories')
        .set(authHeader(accessToken))
        .send({ name: 'Category admin-books', slug: 'admin-books' })
        .expect(201);

      const created = await request(app.getHttpServer())
        .post('/admin/products')
        .set(authHeader(accessToken))
        .send({ name: 'Draft Book', slug: 'draft-book', categoryId: category.body.id, status: 'ACTIVE' })
        .expect(201);
      const productId = created.body.id as string;

      const updated = await request(app.getHttpServer())
        .patch(`/admin/products/${productId}`)
        .set(authHeader(accessToken))
        .send({ name: 'Published Book' });
      expect(updated.status).toBe(200);
      expect(updated.body.name).toBe('Published Book');

      await request(app.getHttpServer()).get(`/products/${productId}`).expect(200);

      const deleted = await request(app.getHttpServer())
        .delete(`/admin/products/${productId}`)
        .set(authHeader(accessToken));
      expect(deleted.status).toBe(200);
      expect(deleted.body.status).toBe('ARCHIVED');

      await request(app.getHttpServer()).get(`/products/${productId}`).expect(404);
    });
  });
});
