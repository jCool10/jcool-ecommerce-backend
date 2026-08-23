import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DRIZZLE, PG_POOL, type DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import { authHeader } from '../setup/auth.helper';
import { createTestProduct } from '../setup/fixtures/catalog.fixture';
import { createTestAdmin } from '../setup/fixtures/user.fixture';
import { withRedisDown } from '../setup/redis-outage';
import { resetCatalogCache } from '../setup/reset-cache';
import { resetDatabase } from '../setup/reset-database';
import { createTestApp } from '../setup/test-app.factory';

const METRICS_TOKEN = 'e2e-catalog-cache-token-abcdef';

// Writing straight through Drizzle bypasses the admin path that bumps the cache generation, so a
// read that still returns the old value proves it came from Redis rather than Postgres — no spies
// at the repository boundary needed.
async function renameBehindTheCache(app: INestApplication, productId: string, name: string): Promise<void> {
  const db = app.get<DrizzleDB>(DRIZZLE);
  await db.update(schema.products).set({ name }).where(eq(schema.products.id, productId));
}

async function readCacheCounter(app: INestApplication, result: 'hit' | 'miss' | 'error'): Promise<number> {
  const res = await request(app.getHttpServer())
    .get('/metrics')
    .set('Authorization', `Bearer ${METRICS_TOKEN}`)
    .expect(200);
  const match = new RegExp(`^catalog_cache_operations_total\\{result="${result}"\\} (\\d+)`, 'm').exec(res.text);
  return match ? Number(match[1]) : 0;
}

describe('Catalog cache-aside (integration, real Postgres + Redis)', () => {
  let app: INestApplication;
  let pool: Pool;

  beforeAll(async () => {
    process.env.METRICS_TOKEN = METRICS_TOKEN;
    app = await createTestApp();
    pool = app.get<Pool>(PG_POOL);
  });

  afterAll(async () => {
    delete process.env.METRICS_TOKEN;
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
    await resetCatalogCache(app);
  });

  describe('read-through', () => {
    it('serves the detail from Redis on the second read (miss → hit)', async () => {
      const { productId, slug } = await createTestProduct(app);

      const first = await request(app.getHttpServer()).get(`/products/${slug}`).expect(200);
      await renameBehindTheCache(app, productId, 'Renamed In Postgres');
      const second = await request(app.getHttpServer()).get(`/products/${slug}`).expect(200);

      expect(second.body.name).toBe(first.body.name);
      expect(second.body.name).not.toBe('Renamed In Postgres');
    });

    it('serves the list from Redis on the second read', async () => {
      const { productId } = await createTestProduct(app);

      const first = await request(app.getHttpServer()).get('/products').expect(200);
      await renameBehindTheCache(app, productId, 'Renamed In Postgres');
      const second = await request(app.getHttpServer()).get('/products').expect(200);

      expect(second.body.items[0].name).toBe(first.body.items[0].name);
    });

    it('hydrates Money and Date through the snapshot round-trip', async () => {
      const { slug, sku, priceMinor } = await createTestProduct(app, { priceMinor: 249_000 });

      await request(app.getHttpServer()).get(`/products/${slug}`).expect(200);
      const cached = await request(app.getHttpServer()).get(`/products/${slug}`).expect(200);

      expect(cached.body.variants[0].sku).toBe(sku);
      expect(cached.body.variants[0].prices[0]).toMatchObject({ amountMinor: priceMinor, currency: 'VND' });
      expect(Number.isNaN(Date.parse(cached.body.createdAt))).toBe(false);
    });

    it('keys the detail by the exact lookup token — id and slug each get their own entry', async () => {
      const { productId, slug } = await createTestProduct(app);

      await request(app.getHttpServer()).get(`/products/${slug}`).expect(200);
      const byId = await request(app.getHttpServer()).get(`/products/${productId}`).expect(200);

      expect(byId.body.id).toBe(productId);
      expect(byId.body.slug).toBe(slug);
    });

    it('does not cache a 404 — an unknown slug stays a miss', async () => {
      await request(app.getHttpServer()).get('/products/no-such-slug').expect(404);
      const missesBefore = await readCacheCounter(app, 'miss');

      await request(app.getHttpServer()).get('/products/no-such-slug').expect(404);

      expect(await readCacheCounter(app, 'miss')).toBeGreaterThan(missesBefore);
    });

    it('counts hits and misses so cache effectiveness is measurable', async () => {
      const { slug } = await createTestProduct(app);
      const [missesBefore, hitsBefore] = [await readCacheCounter(app, 'miss'), await readCacheCounter(app, 'hit')];

      await request(app.getHttpServer()).get(`/products/${slug}`).expect(200);
      await request(app.getHttpServer()).get(`/products/${slug}`).expect(200);

      expect(await readCacheCounter(app, 'miss')).toBe(missesBefore + 1);
      expect(await readCacheCounter(app, 'hit')).toBe(hitsBefore + 1);
    });
  });

  describe('invalidation on admin write', () => {
    async function adminToken(): Promise<string> {
      const { accessToken } = await createTestAdmin(app);
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

    it('stops serving an archived product — the cache never outlives the read filter', async () => {
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

    it('reflects a renamed category in the cached product detail (the coarse bump earns its keep)', async () => {
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

    it('404s a product under its old slug after a rename instead of serving the stale entry', async () => {
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
      const hitsBefore = await readCacheCounter(app, 'hit');

      await request(app.getHttpServer())
        .patch('/admin/products/0197c8f4-3a1b-7c2d-8e4f-1a2b3c4d5e6f')
        .set(authHeader(token))
        .send({ name: 'Nothing To Rename' })
        .expect(404);

      await request(app.getHttpServer()).get(`/products/${slug}`).expect(200);
      expect(await readCacheCounter(app, 'hit')).toBe(hitsBefore + 1);
    });
  });

  describe('Redis unavailable', () => {
    it('keeps serving cached reads from Postgres instead of 500-ing', async () => {
      const { slug } = await createTestProduct(app);

      await withRedisDown(app, async () => {
        const detail = await request(app.getHttpServer()).get(`/products/${slug}`);
        const list = await request(app.getHttpServer()).get('/products');

        expect(detail.status).toBe(200);
        expect(detail.body.slug).toBe(slug);
        expect(list.status).toBe(200);
        expect(list.body.total).toBe(1);
      });

      // The outage is visible as its own label, not silently folded into "miss".
      expect(await readCacheCounter(app, 'error')).toBeGreaterThan(0);
    });

    it('still 500s at the rate-limit guard, which has no fall-through of its own', async () => {
      const { slug } = await createTestProduct(app);

      // The guard reads the kill-switch per request, so this covers the production default
      // (enabled) on the app the rest of this suite runs with the switch off.
      process.env.THROTTLE_ENABLED = 'true';
      try {
        // Pins where the read path's fall-through actually begins: the cache decorator degrades to
        // Postgres, but the throttler's Redis storage is consulted before any of that and rejects
        // hard. Making the guard fail open is a rate-limiting decision, not a caching one.
        await withRedisDown(app, async () => {
          await request(app.getHttpServer()).get(`/products/${slug}`).expect(500);
        });
      } finally {
        process.env.THROTTLE_ENABLED = 'false';
      }
    });
  });
});

describe('Catalog cache TTL (integration)', () => {
  let app: INestApplication;
  let pool: Pool;

  beforeAll(async () => {
    // Shortest TTL the env schema accepts, so expiry is observable without a long sleep.
    app = await createTestApp({ CATALOG_CACHE_TTL_SEC: '1' });
    pool = app.get<Pool>(PG_POOL);
  });

  afterAll(async () => {
    await app.close();
  });

  it('refills from Postgres once the entry expires, bounding how long a missed invalidation could stick', async () => {
    await resetDatabase(pool);
    await resetCatalogCache(app);
    const { productId, slug } = await createTestProduct(app);

    await request(app.getHttpServer()).get(`/products/${slug}`).expect(200);
    await renameBehindTheCache(app, productId, 'Visible After Expiry');
    await new Promise((resolve) => setTimeout(resolve, 1_200));

    const res = await request(app.getHttpServer()).get(`/products/${slug}`).expect(200);
    expect(res.body.name).toBe('Visible After Expiry');
  });
});
