import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CATALOG_SEARCH,
  type CatalogSearchPort,
  type SearchableProduct,
} from '../../src/modules/catalog/application/ports';
import { DrizzleProductRepository, reindexAll } from '../../src/modules/catalog/infrastructure';
import { authHeader } from '../setup/bearer.helper';
import { archiveTestCategory, createTestCategory, createTestProduct } from '../setup/fixtures/catalog.fixture';
import { createTestAdminPrincipal } from '../setup/fixtures/principal.fixture';
import { createTestAppWithPool } from '../setup/harness';
import { resetDatabase } from '../setup/reset-database';
import { resetSearchIndex, startSearchEngine, type StartedSearchEngine } from '../setup/search-engine';

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

// The CLI's rebuild, run in-process against the wired repository.
async function reindex(app: INestApplication): Promise<number> {
  return reindexAll(app.get(DrizzleProductRepository), app.get<CatalogSearchPort>(CATALOG_SEARCH));
}

async function search(app: INestApplication, query: string): Promise<SearchBody> {
  const res = await request(app.getHttpServer()).get(`/products/search?${query}`).expect(200);
  return res.body as SearchBody;
}

const hitIds = (body: SearchBody): string[] => body.items.map((hit) => hit.id);

describe('Catalog search (integration, real Meilisearch + Postgres)', () => {
  let engine: StartedSearchEngine;
  let app: INestApplication;
  let pool: Pool;

  beforeAll(async () => {
    engine = await startSearchEngine();
    ({ app, pool } = await createTestAppWithPool({ SEARCH_ENABLED: 'true', SEARCH_URL: engine.url }));
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await engine?.stop();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
    await resetSearchIndex(app);
  });

  // Must run first: every later test reindexes, and a reindex applies the index settings itself.
  // An index auto-created by a write has no filterable attributes, and a rejected filter reads as
  // an empty result.
  it('applies the index settings at boot, so a filter works before any reindex', async () => {
    const category = await createTestCategory(app, 'Provisioned');
    const { accessToken } = await createTestAdminPrincipal(app);
    const created = await request(app.getHttpServer())
      .post('/admin/products')
      .set(authHeader(accessToken))
      .send({ name: 'Solo Provisioned Item', slug: 'solo-provisioned-item', categoryId: category.id, status: 'ACTIVE' })
      .expect(201);

    const body = await search(app, `q=Provisioned&categorySlug=${category.slug}`);

    expect(hitIds(body)).toEqual([(created.body as { id: string }).id]);
  });

  describe('relevance', () => {
    it('serves the products a reindex loaded out of Postgres', async () => {
      const first = await createTestProduct(app, { name: 'Aurora Bluetooth Speaker' });
      const second = await createTestProduct(app, { name: 'Aurora Desk Lamp' });

      expect(await reindex(app)).toBe(2);
      const body = await search(app, 'q=Aurora');

      expect(hitIds(body).sort()).toEqual([first.productId, second.productId].sort());
      expect(body.total).toBe(2);
    });

    // Attribute order in the index settings is the ranking priority.
    it('ranks a name match above a description-only match', async () => {
      const named = await createTestProduct(app, { name: 'Aurora Speaker', description: 'A plain speaker.' });
      await createTestProduct(app, { name: 'Zephyr Lamp', description: 'Glows like an aurora at dusk.' });

      await reindex(app);
      const body = await search(app, 'q=aurora');

      expect(body.items).toHaveLength(2);
      expect(body.items[0].id).toBe(named.productId);
    });

    it('finds a misspelled name that the Postgres list path cannot', async () => {
      const { productId } = await createTestProduct(app, { name: 'Wireless Headphones' });
      await reindex(app);

      const list = await request(app.getHttpServer()).get('/products?q=Headphnes').expect(200);
      const searched = await search(app, 'q=Headphnes');

      expect((list.body as { items: unknown[] }).items).toHaveLength(0);
      expect(hitIds(searched)).toEqual([productId]);
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

      expect(hitIds(body)).toEqual([inWanted.productId]);
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
    it('indexes only ACTIVE products', async () => {
      const active = await createTestProduct(app, { name: 'Prototype Public' });
      await createTestProduct(app, { name: 'Prototype Draft', status: 'DRAFT' });
      await createTestProduct(app, { name: 'Prototype Retired', status: 'ARCHIVED' });

      await reindex(app);
      const body = await search(app, 'q=Prototype');

      expect(hitIds(body)).toEqual([active.productId]);
    });

    it('leaves a product whose category was archived out of the index', async () => {
      const doomed = await createTestCategory(app, 'Doomed');
      await createTestProduct(app, { name: 'Orphan Widget', categoryId: doomed.id });
      await archiveTestCategory(app, doomed.id);

      expect(await reindex(app)).toBe(0);
      expect((await search(app, 'q=Orphan')).items).toHaveLength(0);
    });

    // A delete that failed while the engine was down leaves a document no reindex revisits.
    it('hides a non-ACTIVE document that reached the index anyway', async () => {
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

  it('pages through the matches and reports a reachable total', async () => {
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
    expect(hitIds(first)).not.toContain(second.items[0].id);
  });

  it('rejects a categorySlug carrying filter syntax before it reaches the engine', async () => {
    await request(app.getHttpServer())
      .get('/products/search')
      .query({ q: 'anything', categorySlug: 'tools" OR status = "DRAFT' })
      .expect(400);
  });
});
