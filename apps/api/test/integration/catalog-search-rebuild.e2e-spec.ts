import { randomUUID } from 'node:crypto';
import type { Client } from '@elastic/elasticsearch';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CATALOG_SEARCH,
  type CatalogSearchPort,
  RebuildInProgressError,
  type SearchDocumentWrite,
  type SearchableProduct,
} from '../../src/modules/catalog/application/ports';
import { DrizzleProductRepository, rebuildIndex, type RebuildResult } from '../../src/modules/catalog/infrastructure';
import {
  PRODUCTS_ALIAS,
  PRODUCTS_INDEX_DEFINITION,
  PRODUCTS_INDEX_PREFIX,
  REBUILD_ALIAS,
} from '../../src/modules/catalog/infrastructure/search/index-settings';
import type { DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import { authHeader } from '../setup/bearer.helper';
import { drainDomainEvents } from '../setup/domain-events';
import { createTestCategory, type TestCategory } from '../setup/fixtures/catalog.fixture';
import { createTestAdminPrincipal, type TestPrincipal } from '../setup/fixtures/principal.fixture';
import { createTestAppWithPool } from '../setup/harness';
import { resetDatabase } from '../setup/reset-database';
import {
  readAliasTargets,
  readDocumentVersions,
  readPhysicalIndices,
  refreshSearchIndex,
  resetSearchIndex,
  searchEnv,
  startSearchEngine,
  type StartedSearchEngine,
} from '../setup/search-engine';

const INITIAL_INDEX = `${PRODUCTS_INDEX_PREFIX}0`;
// Nothing points at it, as when a run dies between releasing its lock and deleting its index.
const ORPHAN_INDEX = `${PRODUCTS_INDEX_PREFIX}1`;

let seq = 0;
const uniq = (): string => `${Date.now()}-${seq++}`;

function doc(name: string): SearchableProduct {
  const id = randomUUID();
  return {
    id,
    name,
    slug: `rebuild-${id}`,
    description: null,
    categorySlug: 'rebuild',
    categoryName: 'Rebuild',
    status: 'ACTIVE',
    skus: [],
    minPriceMinor: null,
    currency: null,
    createdAtEpoch: Date.now(),
  };
}

const live = (product: SearchableProduct, version: number): SearchDocumentWrite => ({
  id: product.id,
  version,
  doc: product,
});

describe('Catalog search rebuild (integration, real Postgres + Redis + Elasticsearch)', () => {
  let engine: StartedSearchEngine;
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;
  let admin: TestPrincipal;
  let category: TestCategory;

  beforeAll(async () => {
    engine = await startSearchEngine();
    ({ app, pool, db } = await createTestAppWithPool(searchEnv(engine)));
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await engine?.stop();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
    await resetSearchIndex(app, engine);
    admin = await createTestAdminPrincipal(app);
    category = await createTestCategory(app, 'Rebuild');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const port = (): CatalogSearchPort => app.get<CatalogSearchPort>(CATALOG_SEARCH);

  const send = (method: 'post' | 'patch' | 'delete', path: string, body?: object): request.Test => {
    const req = request(app.getHttpServer())[method](path).set(authHeader(admin.accessToken));
    return body ? req.send(body) : req;
  };

  async function createProduct(name: string, status: 'ACTIVE' | 'DRAFT' = 'ACTIVE'): Promise<string> {
    const res = await send('post', '/admin/products', {
      name,
      slug: `rebuild-${uniq()}`,
      categoryId: category.id,
      status,
    }).expect(201);
    return (res.body as { id: string }).id;
  }

  async function converge(): Promise<void> {
    await drainDomainEvents(app);
    await refreshSearchIndex(engine);
  }

  /** ACTIVE products created through the admin API and indexed live, so each has a version and a document. */
  async function seed(...names: string[]): Promise<string[]> {
    const ids: string[] = [];
    for (const name of names) ids.push(await createProduct(name));
    await converge();
    return ids.sort();
  }

  const found = async (q: string): Promise<string[]> =>
    (await port().search({ q, page: 1, pageSize: 20 })).items.map((hit) => hit.id).sort();

  // No refresh after it on purpose: the promote must leave the new index searchable by itself.
  const rebuild = (): Promise<RebuildResult> =>
    rebuildIndex(app.get(DrizzleProductRepository), port(), { pageSize: 2, graceMs: 0 });

  async function rowVersions(): Promise<Record<string, number>> {
    const rows = await db
      .select({ id: schema.products.id, version: schema.products.searchVersion })
      .from(schema.products);
    return Object.fromEntries(rows.map((row) => [row.id, row.version]));
  }

  /** Runs `step` once, right after the first page of the fill has landed, and hands it that page. */
  function afterFirstPage(step: (page: SearchDocumentWrite[]) => Promise<void>): void {
    const search = port();
    const writeRebuild = search.writeRebuild.bind(search);
    vi.spyOn(search, 'writeRebuild').mockImplementationOnce(async (changes) => {
      await writeRebuild(changes);
      await step(changes);
    });
  }

  it('moves search onto one fresh index and deletes the one it replaced', async () => {
    const ids = await seed('Cobalt Anchor', 'Cobalt Buoy', 'Cobalt Compass');
    expect(await readAliasTargets(engine)).toEqual({ [PRODUCTS_ALIAS]: [INITIAL_INDEX] });

    const result = await rebuild();

    const aliases = await readAliasTargets(engine);
    expect(aliases).toEqual({ [PRODUCTS_ALIAS]: [expect.stringMatching(/^products_v[1-9]\d*$/)] });
    expect(await readPhysicalIndices(engine)).toEqual(aliases[PRODUCTS_ALIAS]);
    expect(result).toEqual({ documents: 3, tombstones: 0, retired: [INITIAL_INDEX] });
    expect(await found('Cobalt')).toEqual(ids);
  });

  it('drops a document that has no product row behind it', async () => {
    const ids = await seed('Ghostly Anchor');
    const ghost = doc('Ghostly Buoy');
    await engine.client.index({ index: PRODUCTS_ALIAS, id: ghost.id, document: ghost });
    await refreshSearchIndex(engine);
    expect(await found('Ghostly')).toEqual([...ids, ghost.id].sort());

    await rebuild();

    expect(await found('Ghostly')).toEqual(ids);
  });

  it('keeps answering searches throughout the build', async () => {
    const ids = await seed('Harbor Anchor', 'Harbor Buoy', 'Harbor Compass', 'Harbor Dock', 'Harbor Easel');
    const search = port();
    const seen: string[][] = [];
    const look = async () => {
      seen.push(await found('Harbor'));
    };
    const writeRebuild = search.writeRebuild.bind(search);
    const promoteRebuild = search.promoteRebuild.bind(search);
    vi.spyOn(search, 'writeRebuild').mockImplementation(async (changes) => {
      await look();
      await writeRebuild(changes);
    });
    vi.spyOn(search, 'promoteRebuild').mockImplementation(async (rebuild) => {
      await look();
      const retired = await promoteRebuild(rebuild);
      await look();
      return retired;
    });

    await rebuild();

    // Three pages of the fill, then either side of the swap.
    expect(seen).toEqual(Array.from({ length: 5 }, () => ids));
  });

  it('never serves a product archived during the build, before or after the swap', async () => {
    const ids = await seed('Maple Anchor', 'Maple Buoy', 'Maple Compass', 'Maple Dock', 'Maple Easel');
    const search = port();
    const seen: Record<string, string[]> = {};
    let archived = '';
    // The fill has already written this product, so only the live write can carry the archive into the new index.
    afterFirstPage(async (page) => {
      archived = page[0].id;
      seen.beforeArchive = await found('Maple');
      await send('delete', `/admin/products/${archived}`).expect(200);
      await converge();
      seen.afterDrain = await found('Maple');
    });
    const promoteRebuild = search.promoteRebuild.bind(search);
    vi.spyOn(search, 'promoteRebuild').mockImplementationOnce(async (rebuild) => {
      const retired = await promoteRebuild(rebuild);
      seen.afterPromote = await found('Maple');
      return retired;
    });
    const dropRetired = search.dropRetired.bind(search);
    vi.spyOn(search, 'dropRetired').mockImplementationOnce(async (indices) => {
      await dropRetired(indices);
      seen.afterDrop = await found('Maple');
    });

    await rebuild();

    const kept = ids.filter((id) => id !== archived);
    expect(kept).toHaveLength(4);
    expect(seen).toEqual({ beforeArchive: ids, afterDrain: kept, afterPromote: kept, afterDrop: kept });
  });

  it('carries a rename made during the build into the new index', async () => {
    await seed('Willow Anchor', 'Willow Buoy', 'Willow Compass');
    let renamed = '';
    let formerWord = '';
    let foundBefore: string[] = [];
    afterFirstPage(async (page) => {
      renamed = page[0].id;
      formerWord = page[0].doc?.name.split(' ')[1] ?? '';
      foundBefore = await found(formerWord);
      await send('patch', `/admin/products/${renamed}`, { name: 'Willow Zeppelin' }).expect(200);
      await converge();
    });

    await rebuild();

    expect(foundBefore).toEqual([renamed]);
    expect(await found('Zeppelin')).toEqual([renamed]);
    expect(await found(formerWord)).toEqual([]);
  });

  it('lands a live write whether or not a rebuild is running, and during one in both indices', async () => {
    const before = doc('Lone Anchor');
    const during = doc('Lone Buoy');
    await expect(port().write([live(before, 1)])).resolves.toBeUndefined();

    await port().beginRebuild();
    const { [PRODUCTS_ALIAS]: serving, [REBUILD_ALIAS]: building } = await readAliasTargets(engine);
    await expect(port().write([live(during, 2)])).resolves.toBeUndefined();

    expect(await readDocumentVersions(engine, serving[0])).toEqual({ [before.id]: 1, [during.id]: 2 });
    expect(await readDocumentVersions(engine, building[0])).toEqual({ [during.id]: 2 });
  });

  it('leaves every document at its row version, tombstones included', async () => {
    const [edited] = await seed('Parity Anchor', 'Parity Buoy');
    await createProduct('Parity Funnel', 'DRAFT');
    const archived = await createProduct('Parity Sieve');
    await send('delete', `/admin/products/${archived}`).expect(200);
    await send('patch', `/admin/products/${edited}`, { name: 'Parity Kettle' }).expect(200);
    await converge();

    const result = await rebuild();

    expect(result).toMatchObject({ documents: 2, tombstones: 2 });
    const rows = await rowVersions();
    // Versions that differ between products, so a fill writing one version for all cannot pass.
    expect(Object.values(rows).sort()).toEqual([0, 0, 1, 1]);
    expect(rows).toMatchObject({ [edited]: 1, [archived]: 1 });
    expect(await readDocumentVersions(engine, PRODUCTS_ALIAS)).toEqual(rows);
  });

  it('refuses a second rebuild while one is running and leaves both alone', async () => {
    const ids = await seed('Lock Anchor');
    await port().beginRebuild();
    const running = await readAliasTargets(engine);
    expect(running[REBUILD_ALIAS]).toHaveLength(1);

    await expect(rebuild()).rejects.toBeInstanceOf(RebuildInProgressError);

    expect(await readAliasTargets(engine)).toEqual(running);
    expect(await found('Lock')).toEqual(ids);
  });

  it('refuses a rebuild that raced past the lock check', async () => {
    await port().beginRebuild();
    const running = await readAliasTargets(engine);
    const indices = await readPhysicalIndices(engine);
    const client = (port() as unknown as { client: Client }).client;
    vi.spyOn(client.indices, 'existsAlias').mockResolvedValueOnce(false);

    await expect(port().beginRebuild()).rejects.toBeInstanceOf(RebuildInProgressError);

    expect(await readAliasTargets(engine)).toEqual(running);
    expect(await readPhysicalIndices(engine)).toEqual(indices);
  });

  it('fails a rebuild whose lock was cleared under it, and leaves search and the new lock alone', async () => {
    const ids = await seed('Usurped Anchor', 'Usurped Buoy', 'Usurped Compass');
    let usurper = '';
    afterFirstPage(async () => {
      await port().abortRebuild();
      usurper = await port().beginRebuild();
    });

    await expect(rebuild()).rejects.toThrow('no longer holds the rebuild lock');

    expect(await readAliasTargets(engine)).toEqual({ [PRODUCTS_ALIAS]: [INITIAL_INDEX], [REBUILD_ALIAS]: [usurper] });
    expect(await found('Usurped')).toEqual(ids);
  });

  it('keeps the index a swap moved search onto, even when the abort read the aliases before that swap', async () => {
    const rebuilt = await port().beginRebuild();
    const client = (port() as unknown as { client: Client }).client;
    const beforeSwap = await client.indices.getAlias({ index: `${PRODUCTS_INDEX_PREFIX}*` });
    await port().promoteRebuild(rebuilt);
    expect(await readAliasTargets(engine)).toEqual({ [PRODUCTS_ALIAS]: [rebuilt] });
    // As when the swap timed out on the client yet still applied, after the abort had looked.
    vi.spyOn(client.indices, 'getAlias').mockResolvedValueOnce(beforeSwap);

    await port().abortRebuild(rebuilt);

    expect(await readAliasTargets(engine)).toEqual({ [PRODUCTS_ALIAS]: [rebuilt] });
    expect(await readPhysicalIndices(engine)).toContain(rebuilt);
  });

  it('clears a stale rebuild, then rebuilds', async () => {
    const ids = await seed('Stale Anchor');
    await port().beginRebuild();
    const [stale] = (await readAliasTargets(engine))[REBUILD_ALIAS];
    expect(await readPhysicalIndices(engine)).toContain(stale);

    await port().abortRebuild();
    await rebuild();

    const aliases = await readAliasTargets(engine);
    expect(aliases).toEqual({ [PRODUCTS_ALIAS]: [expect.stringMatching(/^products_v[1-9]\d*$/)] });
    expect(await readPhysicalIndices(engine)).toEqual(aliases[PRODUCTS_ALIAS]);
    expect(aliases[PRODUCTS_ALIAS]).not.toContain(stale);
    expect(await found('Stale')).toEqual(ids);
  });

  it('restores a lost search alias', async () => {
    const ids = await seed('Adrift Anchor');
    expect(await found('Adrift')).toEqual(ids);
    await engine.client.indices.deleteAlias({ index: INITIAL_INDEX, name: PRODUCTS_ALIAS });
    expect(await found('Adrift')).toEqual([]);

    await rebuild();

    expect(await found('Adrift')).toEqual(ids);
    const aliases = await readAliasTargets(engine);
    expect(await readPhysicalIndices(engine)).toEqual(aliases[PRODUCTS_ALIAS]);
  });

  it('sweeps an orphan index a crashed run left behind', async () => {
    await engine.client.indices.create({ index: ORPHAN_INDEX, ...PRODUCTS_INDEX_DEFINITION });
    expect(await readPhysicalIndices(engine)).toEqual([INITIAL_INDEX, ORPHAN_INDEX]);

    const { retired } = await rebuild();

    expect([...retired].sort()).toEqual([INITIAL_INDEX, ORPHAN_INDEX]);
    expect(await readPhysicalIndices(engine)).toEqual((await readAliasTargets(engine))[PRODUCTS_ALIAS]);
  });

  it('deletes only the indices nothing serves from', async () => {
    const ids = await seed('Guard Anchor');
    await engine.client.indices.create({ index: ORPHAN_INDEX, ...PRODUCTS_INDEX_DEFINITION });
    await port().beginRebuild();
    const [building] = (await readAliasTargets(engine))[REBUILD_ALIAS];

    await port().dropRetired([INITIAL_INDEX, building, ORPHAN_INDEX]);

    expect(await readPhysicalIndices(engine)).toEqual([INITIAL_INDEX, building].sort());

    // Carrying both aliases is never a state a rebuild leaves; the abort still keeps the index search is served from.
    await engine.client.indices.putAlias({ index: INITIAL_INDEX, name: REBUILD_ALIAS, is_write_index: false });
    await port().abortRebuild();

    expect(await readPhysicalIndices(engine)).toEqual([INITIAL_INDEX]);
    expect(await found('Guard')).toEqual(ids);
  });
});
