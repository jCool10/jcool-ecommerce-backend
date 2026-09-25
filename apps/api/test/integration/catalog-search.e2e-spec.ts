import { randomUUID } from 'node:crypto';
import type { Client } from '@elastic/elasticsearch';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import {
  CATALOG_SEARCH,
  type CatalogSearchPort,
  type SearchDocumentWrite,
  type SearchableProduct,
} from '../../src/modules/catalog/application/ports';
import {
  DrizzleProductRepository,
  ElasticsearchCatalogSearch,
  rebuildIndex,
  type RebuildResult,
} from '../../src/modules/catalog/infrastructure';
import {
  PRODUCTS_ALIAS,
  PRODUCTS_INDEX_DEFINITION,
  PRODUCTS_INDEX_PREFIX,
  SEARCH_MAX_TOTAL_HITS,
} from '../../src/modules/catalog/infrastructure/search/index-settings';
import { authHeader } from '../setup/bearer.helper';
import { drainDomainEvents } from '../setup/domain-events';
import { archiveTestCategory, createTestCategory, createTestProduct } from '../setup/fixtures/catalog.fixture';
import { createTestAdminPrincipal } from '../setup/fixtures/principal.fixture';
import { createTestAppWithPool } from '../setup/harness';
import { resetDatabase } from '../setup/reset-database';
import {
  UNREACHABLE_SEARCH_URL,
  dropSearchIndices,
  readPhysicalIndices,
  refreshSearchIndex,
  resetSearchIndex,
  searchEnv,
  startSearchEngine,
  type StartedSearchEngine,
} from '../setup/search-engine';

interface SearchHitBody {
  id: string;
  name: string;
  highlight?: { name?: string; description?: string };
}

interface SearchBody {
  items: SearchHitBody[];
  total: number;
  totalPages: number;
}

const INITIAL_INDEX = `${PRODUCTS_INDEX_PREFIX}0`;

const hitIds = (body: { items: { id: string }[] }): string[] => body.items.map((hit) => hit.id);

function doc(overrides: Partial<SearchableProduct> = {}): SearchableProduct {
  const id = randomUUID();
  return {
    id,
    name: 'Contract Lantern',
    slug: `contract-${id}`,
    description: null,
    categorySlug: 'lighting',
    categoryName: 'Lighting',
    status: 'ACTIVE',
    skus: [],
    minPriceMinor: null,
    currency: null,
    createdAtEpoch: Date.now(),
    ...overrides,
  };
}

const live = (product: SearchableProduct, version = 0): SearchDocumentWrite => ({
  id: product.id,
  version,
  doc: product,
});
const tombstone = (id: string, version: number): SearchDocumentWrite => ({ id, version, doc: null });

describe('Catalog search (integration, real Elasticsearch + Postgres)', () => {
  let engine: StartedSearchEngine;
  let app: INestApplication;
  let pool: Pool;

  beforeAll(async () => {
    engine = await startSearchEngine();
    ({ app, pool } = await createTestAppWithPool(searchEnv(engine)));
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await engine?.stop();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
    await resetSearchIndex(app, engine);
  });

  const port = (): CatalogSearchPort => app.get<CatalogSearchPort>(CATALOG_SEARCH);

  // The CLI's rebuild, run in-process against the wired repository.
  async function reindex(): Promise<Omit<RebuildResult, 'retired'>> {
    const { documents, tombstones } = await rebuildIndex(app.get(DrizzleProductRepository), port(), { graceMs: 0 });
    return { documents, tombstones };
  }

  async function search(query: Record<string, string | number>): Promise<SearchBody> {
    const res = await request(app.getHttpServer()).get('/products/search').query(query).expect(200);
    return res.body as SearchBody;
  }

  async function put(...changes: SearchDocumentWrite[]): Promise<void> {
    await port().write(changes);
    await refreshSearchIndex(engine);
  }

  async function find(q: string, categorySlug?: string): Promise<string[]> {
    return hitIds(await port().search({ q, page: 1, pageSize: 20, categorySlug }));
  }

  async function stored(id: string): Promise<{ version?: number; name?: string; status?: string }> {
    const res = await engine.client.get<Partial<SearchableProduct>>({ index: PRODUCTS_ALIAS, id });
    return { version: res._version, name: res._source?.name, status: res._source?.status };
  }

  it('serves a product created through the admin API once its change event is delivered', async () => {
    const category = await createTestCategory(app, 'Provisioned');
    const { accessToken } = await createTestAdminPrincipal(app);
    const created = await request(app.getHttpServer())
      .post('/admin/products')
      .set(authHeader(accessToken))
      .send({ name: 'Solo Provisioned Item', slug: 'solo-provisioned-item', categoryId: category.id, status: 'ACTIVE' })
      .expect(201);

    await drainDomainEvents(app);
    await refreshSearchIndex(engine);
    const body = await search({ q: 'Provisioned', categorySlug: category.slug });

    expect(hitIds(body)).toEqual([(created.body as { id: string }).id]);
  });

  describe('index bootstrap', () => {
    it('converges concurrent and repeated bootstraps on one index behind the alias', async () => {
      await dropSearchIndices(engine);

      await Promise.all([port().ensureIndex(), port().ensureIndex(), port().ensureIndex()]);
      await port().ensureIndex();
      await port().ensureIndex();

      expect(Object.keys(await engine.client.indices.getAlias({ name: PRODUCTS_ALIAS }))).toEqual([INITIAL_INDEX]);
      expect(await readPhysicalIndices(engine)).toEqual([INITIAL_INDEX]);
    });

    const liveFields = async (): Promise<string[]> => {
      const mapping = await engine.client.indices.getMapping({ index: INITIAL_INDEX });
      return Object.keys(mapping[INITIAL_INDEX].mappings.properties ?? {});
    };

    // The index as an earlier deploy defined it, before `currency` joined the mapping.
    async function createOlderIndex(): Promise<void> {
      const { settings, mappings } = PRODUCTS_INDEX_DEFINITION;
      const olderProperties = Object.fromEntries(
        Object.entries(mappings.properties ?? {}).filter(([field]) => field !== 'currency'),
      );
      await dropSearchIndices(engine);
      await engine.client.indices.create({
        index: INITIAL_INDEX,
        settings,
        mappings: { ...mappings, properties: olderProperties },
      });
      expect(await liveFields()).toContain('name');
      expect(await liveFields()).not.toContain('currency');
    }

    it('adds a field the definition gained to the live mapping without a new index', async () => {
      await createOlderIndex();
      await engine.client.indices.putAlias({ index: INITIAL_INDEX, name: PRODUCTS_ALIAS, is_write_index: true });

      await port().ensureIndex();

      expect(await liveFields()).toContain('currency');
      expect(await readPhysicalIndices(engine)).toEqual([INITIAL_INDEX]);
    });

    it('adopts an index left without its alias and brings its mapping up to date', async () => {
      await createOlderIndex();

      await port().ensureIndex();

      expect(Object.keys(await engine.client.indices.getAlias({ name: PRODUCTS_ALIAS }))).toEqual([INITIAL_INDEX]);
      expect(await liveFields()).toContain('currency');
    });
  });

  describe('relevance', () => {
    it('serves the products a reindex loaded out of Postgres', async () => {
      const first = await createTestProduct(app, { name: 'Aurora Bluetooth Speaker' });
      const second = await createTestProduct(app, { name: 'Aurora Desk Lamp' });

      expect(await reindex()).toEqual({ documents: 2, tombstones: 0 });
      const body = await search({ q: 'Aurora' });

      expect(hitIds(body).sort()).toEqual([first.productId, second.productId].sort());
      expect(body.total).toBe(2);
    });

    it('ranks a name match above a description-only match', async () => {
      const named = await createTestProduct(app, { name: 'Aurora Speaker', description: 'A plain speaker.' });
      await createTestProduct(app, { name: 'Zephyr Lamp', description: 'Glows like an aurora at dusk.' });

      await reindex();
      const body = await search({ q: 'aurora' });

      expect(body.items).toHaveLength(2);
      expect(body.items[0].id).toBe(named.productId);
    });

    it('finds a misspelled name that the Postgres list path cannot', async () => {
      const { productId } = await createTestProduct(app, { name: 'Velvet Ottoman' });
      await reindex();

      const list = await request(app.getHttpServer()).get('/products').query({ q: 'Ottomn' }).expect(200);
      const searched = await search({ q: 'Ottomn' });

      expect((list.body as { items: unknown[] }).items).toHaveLength(0);
      expect(hitIds(searched)).toEqual([productId]);
    });

    it('matches Vietnamese names with or without their diacritics', async () => {
      const shirt = await createTestProduct(app, { name: 'Áo sơ mi lụa' });
      const watch = await createTestProduct(app, { name: 'Đồng hồ đeo tay' });
      await reindex();

      expect(hitIds(await search({ q: 'ao so mi' }))).toEqual([shirt.productId]);
      expect(hitIds(await search({ q: 'dong ho' }))).toEqual([watch.productId]);
      expect(hitIds(await search({ q: 'Đồng hồ' }))).toEqual([watch.productId]);
    });
  });

  describe('filter and highlight', () => {
    it('narrows results to one category', async () => {
      const wanted = await createTestCategory(app, 'Wanted');
      const other = await createTestCategory(app, 'Other');
      const inWanted = await createTestProduct(app, { name: 'Gadget One', categoryId: wanted.id });
      await createTestProduct(app, { name: 'Gadget Two', categoryId: other.id });

      await reindex();
      const body = await search({ q: 'Gadget', categorySlug: wanted.slug });

      expect(hitIds(body)).toEqual([inWanted.productId]);
    });

    it('treats a category slug carrying filter syntax as a plain value', async () => {
      const tools = doc({ name: 'Quotable Hammer', categorySlug: 'tools' });
      await put(live(tools), live(doc({ name: 'Quotable Rake', categorySlug: 'garden' })));

      expect(await find('Quotable', 'tools')).toEqual([tools.id]);
      expect(await find('Quotable', 'tools" OR status = "DRAFT')).toEqual([]);
    });

    it('marks the matched words in the name and the description', async () => {
      await createTestProduct(app, { name: 'Aurora Speaker', description: 'The Aurora fills the room.' });

      await reindex();
      const [hit] = (await search({ q: 'Aurora' })).items;

      expect(hit.highlight?.name).toContain('<em>Aurora</em>');
      expect(hit.highlight?.description).toContain('<em>Aurora</em>');
    });
  });

  describe('versioned writes', () => {
    it('keeps the newer document when an older version arrives late', async () => {
      const newer = doc({ name: 'Newer Lantern' });

      await put(live(newer, 2));
      await expect(port().write([live({ ...newer, name: 'Older Lantern' }, 1)])).resolves.toBeUndefined();

      expect(await stored(newer.id)).toMatchObject({ version: 2, name: 'Newer Lantern' });
    });

    it('ignores a redelivery at the version it already holds', async () => {
      const first = doc({ name: 'First Lantern' });

      await put(live(first, 1));
      await expect(port().write([live({ ...first, name: 'Second Lantern' }, 1)])).resolves.toBeUndefined();

      expect(await stored(first.id)).toMatchObject({ version: 1, name: 'First Lantern' });
    });

    it('hides a product behind its tombstone until a newer version brings it back', async () => {
      const lantern = doc({ name: 'Tombstoned Lantern' });

      await put(live(lantern, 1));
      expect(await find('Tombstoned')).toEqual([lantern.id]);

      await put(tombstone(lantern.id, 2));
      expect(await find('Tombstoned')).toEqual([]);

      // A late write from before the tombstone must not resurrect it.
      await put(live(lantern, 1));
      expect(await find('Tombstoned')).toEqual([]);
      expect(await stored(lantern.id)).toMatchObject({ version: 2, status: 'INACTIVE' });

      await put(live(lantern, 3));
      expect(await find('Tombstoned')).toEqual([lantern.id]);
    });

    it('rejects a batch holding a document the strict mapping refuses, and names the error', async () => {
      const valid = doc({ name: 'Strict Lantern' });
      const stray = { ...doc({ name: 'Strict Stray' }), colour: 'red' } as SearchableProduct;

      await expect(port().write([live(valid), live(stray)])).rejects.toMatchObject({
        type: 'strict_dynamic_mapping_exception',
      });
      await refreshSearchIndex(engine);

      expect(await find('Strict')).toEqual([valid.id]);
    });

    // The node refuses auto-creation too; it is switched back on here so only the adapter stands in the way.
    it('refuses to write once the alias is gone instead of creating an index', async () => {
      await put(live(doc({ name: 'Aliased Lantern' })));
      expect(await find('Aliased')).toHaveLength(1);

      await engine.client.indices.deleteAlias({ index: INITIAL_INDEX, name: PRODUCTS_ALIAS });
      await engine.client.cluster.putSettings({ persistent: { 'action.auto_create_index': 'true' } });
      try {
        await expect(port().write([live(doc())])).rejects.toBeInstanceOf(Error);
      } finally {
        await engine.client.cluster.putSettings({ persistent: { 'action.auto_create_index': null } });
      }

      expect(await engine.client.indices.exists({ index: PRODUCTS_ALIAS })).toBe(false);
    });
  });

  describe('visibility', () => {
    it('writes a tombstone, not a document, for a product outside the public projection', async () => {
      const active = await createTestProduct(app, { name: 'Prototype Public' });
      await createTestProduct(app, { name: 'Prototype Draft', status: 'DRAFT' });
      await createTestProduct(app, { name: 'Prototype Retired', status: 'ARCHIVED' });

      expect(await reindex()).toEqual({ documents: 1, tombstones: 2 });

      expect(hitIds(await search({ q: 'Prototype' }))).toEqual([active.productId]);
    });

    it('hides a product whose category was archived', async () => {
      const kept = await createTestProduct(app, { name: 'Orphan Widget Kept' });
      const doomed = await createTestCategory(app, 'Doomed');
      await createTestProduct(app, { name: 'Orphan Widget Doomed', categoryId: doomed.id });
      await archiveTestCategory(app, doomed.id);

      expect(await reindex()).toEqual({ documents: 1, tombstones: 1 });

      expect(hitIds(await search({ q: 'Orphan' }))).toEqual([kept.productId]);
    });

    it('hides a non-ACTIVE document that reached the index anyway', async () => {
      const sibling = doc({ name: 'Contraband Sibling' });
      await put(live(sibling), live(doc({ name: 'Contraband Listing', status: 'DRAFT' })));

      expect(await find('Contraband')).toEqual([sibling.id]);
    });
  });

  describe('paging', () => {
    it('pages through the matches and reports a reachable total', async () => {
      const category = await createTestCategory(app, 'Paged');
      for (const index of [1, 2, 3]) {
        await createTestProduct(app, { name: `Paginated Widget ${index}`, categoryId: category.id });
      }
      await reindex();

      const first = await search({ q: 'Paginated', page: 1, pageSize: 2 });
      const second = await search({ q: 'Paginated', page: 2, pageSize: 2 });

      expect(first.total).toBe(3);
      expect(first.totalPages).toBe(2);
      expect(first.items).toHaveLength(2);
      expect(second.items).toHaveLength(1);
      expect(hitIds(first)).not.toContain(second.items[0].id);
    });

    describe('past the paging window', () => {
      beforeEach(async () => {
        await put(
          ...Array.from({ length: SEARCH_MAX_TOTAL_HITS + 5 }, (_, i) => live(doc({ name: `Windowfill ${i}` }))),
        );
      });

      it('serves the last page inside the window', async () => {
        const last = await port().search({ q: 'Windowfill', page: 10, pageSize: 100 });

        expect(last.items).toHaveLength(100);
        expect(last.total).toBe(SEARCH_MAX_TOTAL_HITS);
      });

      it('answers the first page beyond it from a count alone', async () => {
        const client = (port() as unknown as { client: Client }).client;
        const sent = vi.spyOn(client, 'search');
        try {
          const beyond = await port().search({ q: 'Windowfill', page: 11, pageSize: 100 });

          expect(beyond).toEqual({ items: [], total: SEARCH_MAX_TOTAL_HITS });
          const [params] = sent.mock.calls[0] as [Record<string, unknown>];
          expect(params.size).toBe(0);
          expect(params).not.toHaveProperty('from');
        } finally {
          sent.mockRestore();
        }
      });
    });

    it('rejects a categorySlug carrying filter syntax before it reaches the engine', async () => {
      await request(app.getHttpServer())
        .get('/products/search')
        .query({ q: 'anything', categorySlug: 'tools" OR status = "DRAFT' })
        .expect(400);
    });
  });

  it('answers an empty page and fails a write when the engine is unreachable', async () => {
    const reachable = doc({ name: 'Stranded Lantern' });
    await put(live(reachable));
    expect(await find('Stranded')).toEqual([reachable.id]);
    const blind = new ElasticsearchCatalogSearch(
      fakeConfigService({
        'search.enabled': true,
        'search.url': UNREACHABLE_SEARCH_URL,
        'search.requestTimeoutMs': 2_000,
      }),
      { read: { run: (task) => task() }, write: { run: (task) => task() } },
      fakePinoLogger(),
    );

    try {
      await expect(blind.search({ q: 'Stranded', page: 1, pageSize: 20 })).resolves.toEqual({ items: [], total: 0 });
      await expect(blind.write([live(reachable, 1)])).rejects.toBeInstanceOf(Error);
    } finally {
      await blind.onApplicationShutdown();
    }
  });
});
