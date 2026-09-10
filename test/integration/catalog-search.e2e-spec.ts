import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CATALOG_SEARCH, type CatalogSearchPort, type SearchableProduct } from '@modules/catalog/application/ports';
import { DrizzleProductRepository, reindexAll } from '@modules/catalog/infrastructure';
import { PG_POOL } from '@shared/infrastructure/database/drizzle.tokens';
import { archiveTestCategory, createTestCategory, createTestProduct } from '../setup/fixtures/catalog.fixture';
import { resetDatabase } from '../setup/reset-database';
import { resetSearchIndex, startSearchEngine, type StartedSearchEngine } from '../setup/search-engine';
import { createTestApp } from '../setup/test-app.factory';

interface SearchHitBody {
  id: string;
  name: string;
  slug: string;
  categorySlug: string;
  highlight?: { name?: string; description?: string };
}

interface SearchBody {
  items: SearchHitBody[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

// The CLI's own rebuild, driven in-process against the wired repository — so what these tests prove
// is the shipped reindex path, not a copy of its loop.
async function reindex(app: INestApplication): Promise<number> {
  return reindexAll(app.get(DrizzleProductRepository), app.get<CatalogSearchPort>(CATALOG_SEARCH));
}

async function search(app: INestApplication, query: string): Promise<SearchBody> {
  const res = await request(app.getHttpServer()).get(`/products/search?${query}`).expect(200);
  return res.body as SearchBody;
}

describe('Catalog search (integration, real Meilisearch + Postgres)', () => {
  let engine: StartedSearchEngine;
  let app: INestApplication;
  let pool: Pool;

  beforeAll(async () => {
    engine = await startSearchEngine();
    app = await createTestApp({ SEARCH_ENABLED: 'true', SEARCH_URL: engine.url });
    pool = app.get<Pool>(PG_POOL);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await engine?.stop();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
    await resetSearchIndex(app);
  });

  describe('index provisioning', () => {
    // An index the engine auto-creates on the first write has no filterable attributes, which makes
    // the read filter invalid — and an invalid filter degrades to an empty result, so the whole
    // catalog silently reads as "no matches". Booting applies the settings so it never gets there.
    it('accepts a filtered search without a reindex having run first', async () => {
      const { productId, categoryId } = await createTestProduct(app, { name: 'Solo Provisioned Item' });
      const category = await pool.query<{ slug: string }>('SELECT slug FROM categories WHERE id = $1', [categoryId]);

      await reindex(app);
      const body = await search(app, `q=Provisioned&categorySlug=${category.rows[0].slug}`);

      expect(body.items.map((hit) => hit.id)).toEqual([productId]);
    });
  });

  describe('relevance', () => {
    it('serves the products a reindex loaded out of Postgres', async () => {
      const first = await createTestProduct(app, { name: 'Aurora Bluetooth Speaker' });
      const second = await createTestProduct(app, { name: 'Aurora Desk Lamp' });

      expect(await reindex(app)).toBe(2);
      const body = await search(app, 'q=Aurora');

      expect(body.items.map((hit) => hit.id).sort()).toEqual([first.productId, second.productId].sort());
      expect(body.total).toBe(2);
    });

    // Attribute order in the index settings IS the ranking priority; without it both documents match
    // the same single word and nothing decides between them.
    it('ranks a name match above a product that only mentions the term in its description', async () => {
      const named = await createTestProduct(app, { name: 'Aurora Speaker', description: 'A plain speaker.' });
      await createTestProduct(app, { name: 'Zephyr Lamp', description: 'Glows like an aurora at dusk.' });

      await reindex(app);
      const body = await search(app, 'q=aurora');

      expect(body.items).toHaveLength(2);
      expect(body.items[0].id).toBe(named.productId);
    });

    it('finds a product by its SKU code', async () => {
      const { productId, sku } = await createTestProduct(app, { name: 'Nondescript Item', sku: 'ZQX-4417-BLK' });

      await reindex(app);
      const body = await search(app, `q=${sku}`);

      expect(body.items.map((hit) => hit.id)).toEqual([productId]);
    });
  });

  describe('typo tolerance', () => {
    it('finds the product when the query misspells its name', async () => {
      const { productId } = await createTestProduct(app, { name: 'Wireless Headphones' });

      await reindex(app);
      const body = await search(app, 'q=Headphnes');

      expect(body.items.map((hit) => hit.id)).toEqual([productId]);
    });

    // The whole reason a second datastore earns its keep: the list endpoint's substring match over
    // Postgres cannot answer this query at all, so the two read paths are not interchangeable.
    it('answers a misspelling the Postgres list path returns nothing for', async () => {
      await createTestProduct(app, { name: 'Wireless Headphones' });
      await reindex(app);

      const list = await request(app.getHttpServer()).get('/products?q=Headphnes').expect(200);
      const searched = await search(app, 'q=Headphnes');

      expect((list.body as { items: unknown[] }).items).toHaveLength(0);
      expect(searched.items).toHaveLength(1);
    });
  });

  describe('filter and highlight', () => {
    it('narrows results to one category', async () => {
      const wanted = await createTestCategory(app, 'Wanted');
      const other = await createTestCategory(app, 'Other');
      const inWanted = await createTestProduct(app, { name: 'Gadget One', categoryId: wanted.id });
      await createTestProduct(app, { name: 'Gadget Two', categoryId: other.id });

      await reindex(app);
      const body = await search(app, `q=Gadget&categorySlug=${wanted.slug}`);

      expect(body.items.map((hit) => hit.id)).toEqual([inWanted.productId]);
    });

    it('marks the matched words in the name and the description', async () => {
      await createTestProduct(app, { name: 'Aurora Speaker', description: 'The Aurora fills the room.' });

      await reindex(app);
      const [hit] = (await search(app, 'q=Aurora')).items;

      expect(hit.highlight?.name).toContain('<em>Aurora</em>');
      expect(hit.highlight?.description).toContain('<em>Aurora</em>');
    });
  });

  describe('visibility', () => {
    it('leaves a DRAFT product out of the index', async () => {
      const active = await createTestProduct(app, { name: 'Prototype Public' });
      await createTestProduct(app, { name: 'Prototype Secret', status: 'DRAFT' });

      await reindex(app);
      const body = await search(app, 'q=Prototype');

      expect(body.items.map((hit) => hit.id)).toEqual([active.productId]);
    });

    it('leaves an ARCHIVED product out of the index', async () => {
      const active = await createTestProduct(app, { name: 'Kettle Current' });
      await createTestProduct(app, { name: 'Kettle Retired', status: 'ARCHIVED' });

      await reindex(app);
      const body = await search(app, 'q=Kettle');

      expect(body.items.map((hit) => hit.id)).toEqual([active.productId]);
    });

    it('leaves a product whose category was archived out of the index', async () => {
      const doomed = await createTestCategory(app, 'Doomed');
      await createTestProduct(app, { name: 'Orphan Widget', categoryId: doomed.id });
      await archiveTestCategory(app, doomed.id);

      expect(await reindex(app)).toBe(0);
      expect((await search(app, 'q=Orphan')).items).toHaveLength(0);
    });

    // Defence in depth: a delete that failed while the engine was unreachable leaves a document the
    // reindex has no reason to revisit, so the read filter — not just what gets indexed — is what
    // keeps a non-public product out of the results.
    it('refuses to return a non-ACTIVE document that reached the index anyway', async () => {
      const stowaway: SearchableProduct = {
        id: '0197c8f4-3a1b-7c2d-8e4f-1a2b3c4d5e6f',
        name: 'Contraband Listing',
        slug: 'contraband-listing',
        description: null,
        categorySlug: 'anything',
        categoryName: 'Anything',
        status: 'DRAFT',
        skus: [],
        minPriceMinor: null,
        currency: null,
        createdAtEpoch: 0,
      };
      await app.get<CatalogSearchPort>(CATALOG_SEARCH).indexProduct(stowaway);

      expect((await search(app, 'q=Contraband')).items).toHaveLength(0);
    });
  });

  describe('pagination', () => {
    it('pages through the matches and reports a total the caller can reach', async () => {
      const category = await createTestCategory(app, 'Paged');
      for (const index of [1, 2, 3]) {
        await createTestProduct(app, { name: `Paginated Widget ${index}`, categoryId: category.id });
      }
      await reindex(app);

      const first = await search(app, 'q=Paginated&page=1&pageSize=2');
      const second = await search(app, 'q=Paginated&page=2&pageSize=2');

      expect(first.total).toBe(3);
      expect(first.totalPages).toBe(2);
      expect(first.items).toHaveLength(2);
      expect(second.items).toHaveLength(1);
      expect(first.items.map((hit) => hit.id)).not.toContain(second.items[0].id);
    });
  });

  describe('query validation', () => {
    it('rejects a categorySlug carrying filter syntax before it reaches the engine', async () => {
      await request(app.getHttpServer())
        .get('/products/search')
        .query({ q: 'anything', categorySlug: 'tools" OR status = "DRAFT' })
        .expect(400);
    });

    it('rejects a whitespace-only query', async () => {
      await request(app.getHttpServer()).get('/products/search').query({ q: '   ' }).expect(400);
    });
  });
});
