import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DRIZZLE, type DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import { authHeader } from '../setup/auth.helper';
import { createTestProduct } from '../setup/fixtures/catalog.fixture';
import { createTestAdmin } from '../setup/fixtures/user.fixture';
import { closeAppAfterAll, createTestAppWithPool } from '../setup/harness';
import { E2E_METRICS_TOKEN, metricsAuthHeader } from '../setup/metrics.helper';
import { withRedisDown } from '../setup/redis-outage';
import { resetCatalogCache } from '../setup/reset-cache';
import { resetDatabase } from '../setup/reset-database';

// Writing straight through Drizzle bypasses the admin path that bumps the cache generation, so a
// read that still returns the old value proves it came from Redis rather than Postgres — no spies
// at the repository boundary needed.
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
    // Pinned rather than defaulted: every assertion below is about an entry still being fresh, and a
    // local .env would otherwise get to decide how long that is.
    ({ app, pool } = await createTestAppWithPool({
      CATALOG_CACHE_TTL_SEC: '60',
      CACHE_STALE_WINDOW_SEC: '30',
      CACHE_TTL_JITTER_SEC: '10',
      CACHE_LOCK_WAIT_MS: '500',
    }));
  });

  // Explicit rather than `closeAppAfterAll`: the token has to be cleared too.
  afterAll(async () => {
    delete process.env.METRICS_TOKEN;
    await app.close();
  });

  // Explicit rather than `resetDatabaseBeforeEach`: the cache generation has to be bumped after the
  // truncate, or the next read is served from the previous test's rows out of Redis.
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

describe('Catalog cache freshness window (integration)', () => {
  let app: INestApplication;
  let pool: Pool;

  // A second app, not a second test on the first: the fresh window is read once when the module
  // compiles, and this suite needs a 1s window where the first suite needs 60s.
  beforeAll(async () => {
    // Shortest fresh window the env schema accepts, so the stale path is reachable without a long
    // sleep. The stale window is pinned wide and jitter off: with a local `CACHE_STALE_WINDOW_SEC=0`
    // the entry would be deleted at the same moment it goes stale and this would test a miss.
    ({ app, pool } = await createTestAppWithPool({
      CATALOG_CACHE_TTL_SEC: '1',
      CACHE_STALE_WINDOW_SEC: '30',
      CACHE_TTL_JITTER_SEC: '0',
    }));
  });
  closeAppAfterAll(() => app);

  it('answers from the stale entry the moment the fresh window closes, then from the refill behind it', async () => {
    await resetDatabase(pool);
    await resetCatalogCache(app);
    const { productId, slug } = await createTestProduct(app);

    const first = await request(app.getHttpServer()).get(`/products/${slug}`).expect(200);
    await renameBehindTheCache(app, productId, 'Visible After Refresh');
    await new Promise((resolve) => setTimeout(resolve, 1_200));

    // Nobody waits on the rebuild: the read that finds the entry stale still answers from it.
    const served = await request(app.getHttpServer()).get(`/products/${slug}`).expect(200);
    expect(served.body.name).toBe(first.body.name);

    await expect
      .poll(async () => (await request(app.getHttpServer()).get(`/products/${slug}`)).body.name, { timeout: 5_000 })
      .toBe('Visible After Refresh');
  });
});

describe('Catalog cache hard expiry (integration)', () => {
  let app: INestApplication;
  let pool: Pool;

  // A third app for the third window configuration: stale-serving off, which neither suite above can
  // reach without changing what they prove.
  beforeAll(async () => {
    process.env.METRICS_TOKEN = E2E_METRICS_TOKEN;
    // Stale-serving and jitter switched off, so the entry's whole life is the fresh window. This is
    // what bounds staleness after a missed invalidation: the three windows, and nothing beyond them.
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

  it('drops the entry once the windows close, so the next read answers from Postgres', async () => {
    await resetDatabase(pool);
    await resetCatalogCache(app);
    const { productId, slug } = await createTestProduct(app);

    await request(app.getHttpServer()).get(`/products/${slug}`).expect(200);
    await renameBehindTheCache(app, productId, 'Visible After Expiry');
    await new Promise((resolve) => setTimeout(resolve, 1_200));

    const missesBefore = await readCacheCounter(app, 'miss');
    // No poll: with nothing left to serve, the read rebuilds inline rather than answering stale.
    const served = await request(app.getHttpServer()).get(`/products/${slug}`).expect(200);

    expect(served.body.name).toBe('Visible After Expiry');
    expect(await readCacheCounter(app, 'miss')).toBe(missesBefore + 1);
  });
});
