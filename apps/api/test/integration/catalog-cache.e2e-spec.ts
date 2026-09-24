import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DRIZZLE, type DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import { authHeader } from '../setup/bearer.helper';
import { createTestProduct } from '../setup/fixtures/catalog.fixture';
import { createTestAdminPrincipal } from '../setup/fixtures/principal.fixture';
import { createTestAppWithPool } from '../setup/harness';
import { E2E_METRICS_TOKEN, metricsAuthHeader } from '../setup/metrics.helper';
import { withRedisDown } from '../setup/redis-outage';
import { resetCatalogCache } from '../setup/reset-cache';
import { resetDatabase } from '../setup/reset-database';

// Skips the admin path that bumps the cache generation, so an unchanged read came from Redis.
async function renameBehindTheCache(app: INestApplication, productId: string, name: string): Promise<void> {
  const db = app.get<DrizzleDB>(DRIZZLE);
  await db.update(schema.products).set({ name }).where(eq(schema.products.id, productId));
}

async function readCacheCounter(app: INestApplication, result: 'hit_fresh' | 'miss' | 'error'): Promise<number> {
  const res = await request(app.getHttpServer()).get('/metrics').set(metricsAuthHeader()).expect(200);
  const match = new RegExp(`^catalog_cache_operations_total\\{result="${result}"\\} (\\d+)`, 'm').exec(res.text);
  return match ? Number(match[1]) : 0;
}

describe('Catalog cache-aside (integration, real Postgres + Redis)', () => {
  let app: INestApplication;
  let pool: Pool;

  beforeAll(async () => {
    process.env.METRICS_TOKEN = E2E_METRICS_TOKEN;
    // Pinned so a local .env cannot shorten the fresh window these assertions rely on.
    ({ app, pool } = await createTestAppWithPool({
      CATALOG_CACHE_TTL_SEC: '60',
      CACHE_STALE_WINDOW_SEC: '30',
      CACHE_TTL_JITTER_SEC: '10',
      CACHE_LOCK_WAIT_MS: '500',
    }));
  });

  afterAll(async () => {
    delete process.env.METRICS_TOKEN;
    await app.close();
  });

  // The generation bump after the truncate keeps the previous test's entries out of reach.
  beforeEach(async () => {
    await resetDatabase(pool);
    await resetCatalogCache(app);
  });

  describe('read-through', () => {
    it('serves the detail and the list from Redis on the second read', async () => {
      const { productId, slug } = await createTestProduct(app);

      const firstDetail = await request(app.getHttpServer()).get(`/products/${slug}`).expect(200);
      const firstList = await request(app.getHttpServer()).get('/products').expect(200);
      await renameBehindTheCache(app, productId, 'Renamed In Postgres');
      const secondDetail = await request(app.getHttpServer()).get(`/products/${slug}`).expect(200);
      const secondList = await request(app.getHttpServer()).get('/products').expect(200);

      expect(secondDetail.body.name).toBe(firstDetail.body.name);
      expect(secondDetail.body.name).not.toBe('Renamed In Postgres');
      expect(secondList.body.items[0].name).toBe(firstList.body.items[0].name);
    });

    it('hydrates Money and Date through the snapshot round-trip', async () => {
      const { slug, sku, priceMinor } = await createTestProduct(app, { priceMinor: 249_000 });

      await request(app.getHttpServer()).get(`/products/${slug}`).expect(200);
      const cached = await request(app.getHttpServer()).get(`/products/${slug}`).expect(200);

      expect(cached.body.variants[0].sku).toBe(sku);
      expect(cached.body.variants[0].prices[0]).toMatchObject({ amountMinor: priceMinor, currency: 'VND' });
      expect(Number.isNaN(Date.parse(cached.body.createdAt))).toBe(false);
    });

    it('caches the detail separately under its slug and its id', async () => {
      const { productId, slug } = await createTestProduct(app);
      const bySlugBefore = await request(app.getHttpServer()).get(`/products/${slug}`).expect(200);

      await renameBehindTheCache(app, productId, 'Renamed In Postgres');
      const byId = await request(app.getHttpServer()).get(`/products/${productId}`).expect(200);
      const bySlug = await request(app.getHttpServer()).get(`/products/${slug}`).expect(200);

      expect(byId.body).toMatchObject({ id: productId, slug, name: 'Renamed In Postgres' });
      expect(bySlug.body.name).toBe(bySlugBefore.body.name);
    });

    it('does not cache a 404', async () => {
      await request(app.getHttpServer()).get('/products/no-such-slug').expect(404);
      const missesBefore = await readCacheCounter(app, 'miss');

      await request(app.getHttpServer()).get('/products/no-such-slug').expect(404);

      expect(await readCacheCounter(app, 'miss')).toBeGreaterThan(missesBefore);
    });

    it('counts hits and misses', async () => {
      const { slug } = await createTestProduct(app);
      const [missesBefore, hitsBefore] = [
        await readCacheCounter(app, 'miss'),
        await readCacheCounter(app, 'hit_fresh'),
      ];

      await request(app.getHttpServer()).get(`/products/${slug}`).expect(200);
      await request(app.getHttpServer()).get(`/products/${slug}`).expect(200);

      expect(await readCacheCounter(app, 'miss')).toBe(missesBefore + 1);
      expect(await readCacheCounter(app, 'hit_fresh')).toBe(hitsBefore + 1);
    });
  });

  describe('invalidation on admin write', () => {
    async function adminToken(): Promise<string> {
      const { accessToken } = await createTestAdminPrincipal(app);
      return accessToken;
    }

    it('serves the new name after an admin PATCH', async () => {
      const { productId, slug } = await createTestProduct(app);
      const token = await adminToken();
      await request(app.getHttpServer()).get(`/products/${slug}`).expect(200);

      await request(app.getHttpServer())
        .patch(`/admin/products/${productId}`)
        .set(authHeader(token))
        .send({ name: 'Renamed Via Admin' })
        .expect(200);

      const res = await request(app.getHttpServer()).get(`/products/${slug}`).expect(200);
      expect(res.body.name).toBe('Renamed Via Admin');
    });

    it('serves the new price after setPrice', async () => {
      const { slug, variantId } = await createTestProduct(app, { priceMinor: 199_000 });
      const token = await adminToken();
      await request(app.getHttpServer()).get(`/products/${slug}`).expect(200);

      await request(app.getHttpServer())
        .put(`/admin/skus/${variantId}/price`)
        .set(authHeader(token))
        .send({ amountMinor: 149_000, currency: 'VND' })
        .expect(200);

      const res = await request(app.getHttpServer()).get(`/products/${slug}`).expect(200);
      expect(res.body.variants[0].prices[0].amountMinor).toBe(149_000);
    });

    it('stops serving an archived product from the detail and the list', async () => {
      const { productId, slug } = await createTestProduct(app);
      const token = await adminToken();
      await request(app.getHttpServer()).get(`/products/${slug}`).expect(200);
      await request(app.getHttpServer()).get('/products').expect(200);

      await request(app.getHttpServer()).delete(`/admin/products/${productId}`).set(authHeader(token)).expect(200);

      await request(app.getHttpServer()).get(`/products/${slug}`).expect(404);
      const list = await request(app.getHttpServer()).get('/products').expect(200);
      expect(list.body.items.map((item: { id: string }) => item.id)).not.toContain(productId);
    });

    it('shows a newly created product in a previously cached list page', async () => {
      const { categoryId } = await createTestProduct(app);
      const token = await adminToken();
      const before = await request(app.getHttpServer()).get('/products').expect(200);
      expect(before.body.total).toBe(1);

      await request(app.getHttpServer())
        .post('/admin/products')
        .set(authHeader(token))
        .send({ name: 'Fresh Arrival', slug: 'fresh-arrival', categoryId, status: 'ACTIVE' })
        .expect(201);

      const after = await request(app.getHttpServer()).get('/products').expect(200);
      expect(after.body.total).toBe(2);
    });

    it('reflects a renamed category in the cached product detail', async () => {
      const { categoryId, slug } = await createTestProduct(app);
      const token = await adminToken();
      await request(app.getHttpServer()).get(`/products/${slug}`).expect(200);

      await request(app.getHttpServer())
        .patch(`/admin/categories/${categoryId}`)
        .set(authHeader(token))
        .send({ name: 'Renamed Category' })
        .expect(200);

      const res = await request(app.getHttpServer()).get(`/products/${slug}`).expect(200);
      expect(res.body.category.name).toBe('Renamed Category');
    });

    it('404s a product under its old slug after a rename', async () => {
      const { productId, slug } = await createTestProduct(app);
      const token = await adminToken();
      await request(app.getHttpServer()).get(`/products/${slug}`).expect(200);

      await request(app.getHttpServer())
        .patch(`/admin/products/${productId}`)
        .set(authHeader(token))
        .send({ slug: 'brand-new-slug' })
        .expect(200);

      await request(app.getHttpServer()).get(`/products/${slug}`).expect(404);
      await request(app.getHttpServer()).get('/products/brand-new-slug').expect(200);
    });

    it('leaves the cache generation alone when the write 404s', async () => {
      const { slug } = await createTestProduct(app);
      const token = await adminToken();
      await request(app.getHttpServer()).get(`/products/${slug}`).expect(200);
      const hitsBefore = await readCacheCounter(app, 'hit_fresh');

      await request(app.getHttpServer())
        .patch('/admin/products/0197c8f4-3a1b-7c2d-8e4f-1a2b3c4d5e6f')
        .set(authHeader(token))
        .send({ name: 'Nothing To Rename' })
        .expect(404);

      await request(app.getHttpServer()).get(`/products/${slug}`).expect(200);
      expect(await readCacheCounter(app, 'hit_fresh')).toBe(hitsBefore + 1);
    });
  });

  describe('Redis unavailable', () => {
    it('serves reads from Postgres and counts the outage as an error', async () => {
      const { slug } = await createTestProduct(app);

      await withRedisDown(app, async () => {
        const detail = await request(app.getHttpServer()).get(`/products/${slug}`);
        const list = await request(app.getHttpServer()).get('/products');

        expect(detail.status).toBe(200);
        expect(detail.body.slug).toBe(slug);
        expect(list.status).toBe(200);
        expect(list.body.total).toBe(1);
      });

      expect(await readCacheCounter(app, 'error')).toBeGreaterThan(0);
    });

    // The throttler's Redis storage runs before the cache and has no fall-through of its own.
    it('still answers 500 when the rate-limit guard is enabled', async () => {
      const { slug } = await createTestProduct(app);

      process.env.THROTTLE_ENABLED = 'true';
      try {
        await withRedisDown(app, async () => {
          await request(app.getHttpServer()).get(`/products/${slug}`).expect(500);
        });
      } finally {
        process.env.THROTTLE_ENABLED = 'false';
      }
    });
  });
});

describe('Catalog cache hard expiry (integration)', () => {
  let app: INestApplication;
  let pool: Pool;

  beforeAll(async () => {
    process.env.METRICS_TOKEN = E2E_METRICS_TOKEN;
    // Stale serving and jitter off, so the entry lives exactly the fresh window.
    ({ app, pool } = await createTestAppWithPool({
      CATALOG_CACHE_TTL_SEC: '1',
      CACHE_STALE_WINDOW_SEC: '0',
      CACHE_TTL_JITTER_SEC: '0',
    }));
  });

  afterAll(async () => {
    delete process.env.METRICS_TOKEN;
    await app.close();
  });

  it('drops the entry once the window closes, so the next read answers from Postgres', async () => {
    await resetDatabase(pool);
    await resetCatalogCache(app);
    const { productId, slug } = await createTestProduct(app);

    await request(app.getHttpServer()).get(`/products/${slug}`).expect(200);
    await renameBehindTheCache(app, productId, 'Visible After Expiry');
    await new Promise((resolve) => setTimeout(resolve, 1_200));

    const missesBefore = await readCacheCounter(app, 'miss');
    const served = await request(app.getHttpServer()).get(`/products/${slug}`).expect(200);

    expect(served.body.name).toBe('Visible After Expiry');
    expect(await readCacheCounter(app, 'miss')).toBe(missesBefore + 1);
  });
});
