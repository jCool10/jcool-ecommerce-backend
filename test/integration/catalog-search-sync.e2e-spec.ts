import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CATALOG_SEARCH, type CatalogSearchPort } from '../../src/modules/catalog/application/ports';
import { DrizzleProductRepository, reindexAll } from '../../src/modules/catalog/infrastructure';
import { authHeader } from '../setup/auth.helper';
import { createTestCategory } from '../setup/fixtures/catalog.fixture';
import { createTestAdmin } from '../setup/fixtures/user.fixture';
import { createTestAppWithPool } from '../setup/harness';
import { resetDatabase } from '../setup/reset-database';
import {
  resetSearchIndex,
  startSearchEngine,
  UNREACHABLE_SEARCH_URL,
  type StartedSearchEngine,
} from '../setup/search-engine';
import { createTestApp } from '../setup/test-app.factory';

interface SearchBody {
  items: { id: string; name: string; minPriceMinor: number | null }[];
  total: number;
}

let uniqueSuffix = 0;
const uniq = (): string => `${Date.now()}-${uniqueSuffix++}`;

async function searchIds(app: INestApplication, q: string): Promise<string[]> {
  const res = await request(app.getHttpServer()).get('/products/search').query({ q }).expect(200);
  return (res.body as SearchBody).items.map((hit) => hit.id);
}

describe('Catalog search index sync (integration, real Meilisearch + Postgres)', () => {
  let engine: StartedSearchEngine;
  let app: INestApplication;
  // A second app wired to a port nothing listens on — the "search engine is down" half of every
  // best-effort claim, without stopping the container the other assertions still read from.
  let blindApp: INestApplication;
  let pool: Pool;
  let adminToken: string;
  let categoryId: string;

  beforeAll(async () => {
    engine = await startSearchEngine();
    ({ app, pool } = await createTestAppWithPool({ SEARCH_ENABLED: 'true', SEARCH_URL: engine.url }));
    // A second boot, not a second test: `SEARCH_URL` is read once when the module compiles, so
    // "the engine is unreachable" is only expressible as an app that was built that way.
    blindApp = await createTestApp({ SEARCH_ENABLED: 'true', SEARCH_URL: UNREACHABLE_SEARCH_URL });
  }, 180_000);

  afterAll(async () => {
    await blindApp?.close();
    await app?.close();
    await engine?.stop();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
    await resetSearchIndex(app);
    adminToken = (await createTestAdmin(app)).accessToken;
    categoryId = (await createTestCategory(app)).id;
  });

  async function createProductAsAdmin(
    client: INestApplication,
    name: string,
    status: 'DRAFT' | 'ACTIVE' = 'ACTIVE',
  ): Promise<string> {
    const res = await request(client.getHttpServer())
      .post('/admin/products')
      .set(authHeader(adminToken))
      .send({ name, slug: `synced-${uniq()}`, categoryId, status })
      .expect(201);
    return (res.body as { id: string }).id;
  }

  describe('write-through', () => {
    // No reindex between the write and the read: every adapter write awaits the engine's task, so a
    // 201 already means the document is queryable.
    it('makes a newly created product searchable', async () => {
      const productId = await createProductAsAdmin(app, 'Immediate Ottoman');

      expect(await searchIds(app, 'Ottoman')).toEqual([productId]);
    });

    it('reflects a new price on the next search', async () => {
      const productId = await createProductAsAdmin(app, 'Repriced Ottoman');
      const skuRes = await request(app.getHttpServer())
        .post(`/admin/products/${productId}/skus`)
        .set(authHeader(adminToken))
        .send({ sku: `PRICED-${uniq()}`, name: 'Standard' })
        .expect(201);

      await request(app.getHttpServer())
        .put(`/admin/skus/${(skuRes.body as { id: string }).id}/price`)
        .set(authHeader(adminToken))
        .send({ amountMinor: 314_000, currency: 'VND' })
        .expect(200);

      const res = await request(app.getHttpServer()).get('/products/search').query({ q: 'Repriced' }).expect(200);
      expect((res.body as SearchBody).items[0].minPriceMinor).toBe(314_000);
    });

    it('makes a product findable by a SKU code added after it was created', async () => {
      const productId = await createProductAsAdmin(app, 'Late Sku Ottoman');
      const sku = `LATE-${uniq()}`;

      await request(app.getHttpServer())
        .post(`/admin/products/${productId}/skus`)
        .set(authHeader(adminToken))
        .send({ sku, name: 'Standard' })
        .expect(201);

      expect(await searchIds(app, sku)).toEqual([productId]);
    });

    it('drops an archived product out of the results', async () => {
      const productId = await createProductAsAdmin(app, 'Doomed Ottoman');
      expect(await searchIds(app, 'Doomed')).toEqual([productId]);

      await request(app.getHttpServer()).delete(`/admin/products/${productId}`).set(authHeader(adminToken)).expect(200);

      expect(await searchIds(app, 'Doomed')).toEqual([]);
    });

    // The sync re-reads the public projection to decide index-vs-delete, so publishing is not a
    // special case — it is the same re-read answering differently.
    it('indexes a draft only once it is published', async () => {
      const productId = await createProductAsAdmin(app, 'Unpublished Ottoman', 'DRAFT');
      expect(await searchIds(app, 'Unpublished')).toEqual([]);

      await request(app.getHttpServer())
        .patch(`/admin/products/${productId}`)
        .set(authHeader(adminToken))
        .send({ status: 'ACTIVE' })
        .expect(200);

      expect(await searchIds(app, 'Unpublished')).toEqual([productId]);
    });
  });

  describe('engine down', () => {
    it('still completes an admin write', async () => {
      const productId = await createProductAsAdmin(blindApp, 'Written Blind');

      const row = await pool.query('SELECT id FROM products WHERE id = $1', [productId]);
      expect(row.rowCount).toBe(1);
    });

    it('answers a search with an empty result rather than a 500', async () => {
      const res = await request(blindApp.getHttpServer()).get('/products/search').query({ q: 'anything' });

      expect(res.status).toBe(200);
      expect((res.body as SearchBody).items).toEqual([]);
      expect((res.body as SearchBody).total).toBe(0);
    });

    it('leaves the existing index untouched, so the healthy path keeps serving', async () => {
      const survivor = await createProductAsAdmin(app, 'Indexed Before Outage');
      await createProductAsAdmin(blindApp, 'Indexed Before Outage Too');

      expect(await searchIds(app, 'Indexed Before Outage')).toEqual([survivor]);
    });
  });

  // The dual-write gap made concrete: a write that commits while the engine is unreachable is lost
  // to the index and nothing retries it, which is precisely what the reindex command exists to fix.
  describe('reindex backstop', () => {
    it('converges a write the engine missed', async () => {
      const missed = await createProductAsAdmin(blindApp, 'Missed Ottoman');
      expect(await searchIds(app, 'Missed')).toEqual([]);

      await reindexAll(app.get(DrizzleProductRepository), app.get<CatalogSearchPort>(CATALOG_SEARCH));

      expect(await searchIds(app, 'Missed')).toEqual([missed]);
    });

    // The asymmetry worth knowing before trusting a nightly reindex: a missed write is repaired by
    // any rerun, a missed delete only by a reset run. The read filter does not cover this case —
    // the ghost was indexed while it was ACTIVE, so it still satisfies the filter.
    it('keeps serving a delete the engine missed until a reset run prunes it', async () => {
      const productId = await createProductAsAdmin(app, 'Ghost Ottoman');
      await request(blindApp.getHttpServer())
        .delete(`/admin/products/${productId}`)
        .set(authHeader(adminToken))
        .expect(200);

      // Gone from Postgres' public projection, still answered by the index.
      await request(app.getHttpServer()).get(`/products/${productId}`).expect(404);
      expect(await searchIds(app, 'Ghost')).toEqual([productId]);

      const repo = app.get(DrizzleProductRepository);
      const search = app.get<CatalogSearchPort>(CATALOG_SEARCH);

      await reindexAll(repo, search);
      expect(await searchIds(app, 'Ghost')).toEqual([productId]);

      await reindexAll(repo, search, { reset: true });
      expect(await searchIds(app, 'Ghost')).toEqual([]);
    });
  });
});
