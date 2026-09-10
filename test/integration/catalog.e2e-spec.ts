import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PG_POOL } from '@shared/infrastructure/database/drizzle.tokens';
import { authHeader } from '../setup/auth.helper';
import {
  archiveTestCategory,
  createTestCategory,
  createTestProduct,
  seedProducts,
} from '../setup/fixtures/catalog.fixture';
import { createTestAdmin, createTestUser } from '../setup/fixtures/user.fixture';
import { resetCatalogCache } from '../setup/reset-cache';
import { resetDatabase } from '../setup/reset-database';
import { createTestApp } from '../setup/test-app.factory';

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
    await resetCatalogCache(app);
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

    // Both bounds are query-shape gates rather than data answers: an out-of-range page is a deep
    // OFFSET scan and a non-slug filter can never match a row, and each distinct value would mint
    // its own cache key on the way to saying nothing.
    it('rejects a page past the ceiling with 400 rather than scanning to an empty page', async () => {
      const res = await request(app.getHttpServer()).get('/products').query({ page: 10_001 });

      expect(res.status).toBe(400);
    });

    it('accepts the last page inside the ceiling', async () => {
      const res = await request(app.getHttpServer()).get('/products').query({ page: 10_000 });

      expect(res.status).toBe(200);
      expect(res.body.items).toEqual([]);
    });

    it('rejects a categorySlug that is not slug-shaped with 400', async () => {
      const res = await request(app.getHttpServer()).get('/products').query({ categorySlug: 'Not A Slug!' });

      expect(res.status).toBe(400);
    });

    it('still serves a well-formed categorySlug that matches nothing', async () => {
      const res = await request(app.getHttpServer()).get('/products').query({ categorySlug: 'no-such-category' });

      expect(res.status).toBe(200);
      expect(res.body.items).toEqual([]);
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

    // The list resolves the slug to an id before filtering, so the archived-category guard has to
    // keep holding on the join rather than riding along with the slug lookup.
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

    it('slices by page/pageSize without overlap across pages', async () => {
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

    it('resolves the product by slug (200) — the id-or-slug path, not just uuid', async () => {
      const { productId, slug } = await createTestProduct(app);

      const res = await request(app.getHttpServer()).get(`/products/${slug}`);

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(productId);
      expect(res.body.slug).toBe(slug);
    });

    it('returns 404 for an unknown slug (no text→uuid cast 500)', async () => {
      const res = await request(app.getHttpServer()).get('/products/no-such-slug');
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

    it('rejects a malformed product id with 400, not a 500', async () => {
      const { accessToken } = await createTestAdmin(app);
      const res = await request(app.getHttpServer())
        .patch('/admin/products/not-a-uuid')
        .set(authHeader(accessToken))
        .send({ name: 'x' });

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

      await request(app.getHttpServer()).get(`/products/${productId}`).expect(200);

      const deleted = await request(app.getHttpServer())
        .delete(`/admin/products/${productId}`)
        .set(authHeader(accessToken));
      expect(deleted.status).toBe(200);
      expect(deleted.body.status).toBe('ARCHIVED'); // soft-delete: archived + echoed, not removed

      await request(app.getHttpServer()).get(`/products/${productId}`).expect(404);
    });
  });
});
