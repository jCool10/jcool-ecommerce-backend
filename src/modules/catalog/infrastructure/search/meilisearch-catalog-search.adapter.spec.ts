import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fakeConfigService } from '@shared/testing/fake-config.service';
import { fakePinoLogger } from '@shared/testing/fake-pino-logger';
import type { SearchableProduct } from '../../application/ports';
import { PRODUCTS_INDEX_SETTINGS, SEARCH_MAX_TOTAL_HITS } from './index-settings';
import { MeilisearchCatalogSearch } from './meilisearch-catalog-search.adapter';

const DOC: SearchableProduct = {
  id: 'p1',
  name: 'Widget',
  slug: 'widget',
  description: null,
  categorySlug: 'tools',
  categoryName: 'Tools',
  status: 'ACTIVE',
  skus: ['WIDGET-1'],
  minPriceMinor: 1000,
  currency: 'VND',
  createdAtEpoch: 0,
};

describe('MeilisearchCatalogSearch (disabled)', () => {
  const adapter = new MeilisearchCatalogSearch(fakeConfigService({ 'search.enabled': false }), fakePinoLogger());

  it('search resolves to an empty result', async () => {
    await expect(adapter.search({ q: 'anything', page: 1, pageSize: 20 })).resolves.toEqual({
      items: [],
      total: 0,
    });
  });

  it('write methods resolve as no-ops', async () => {
    await expect(adapter.ensureIndex()).resolves.toBeUndefined();
    await expect(adapter.resetIndex()).resolves.toBeUndefined();
    await expect(adapter.indexProduct(DOC)).resolves.toBeUndefined();
    await expect(adapter.bulkIndex([DOC])).resolves.toBeUndefined();
    await expect(adapter.deleteProduct('p1')).resolves.toBeUndefined();
  });
});

// The engine accepts a write as a task, so an HTTP 202 says nothing about whether the document
// landed — only the settled task does.
describe('MeilisearchCatalogSearch (engine task outcome)', () => {
  let server: http.Server;
  let adapter: MeilisearchCatalogSearch;
  let taskStatus: 'succeeded' | 'failed';

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url?.startsWith('/tasks/')) {
        res.end(
          JSON.stringify({
            uid: 1,
            indexUid: 'products',
            type: 'documentAdditionOrUpdate',
            status: taskStatus,
            error: taskStatus === 'failed' ? { message: 'no space left on device' } : null,
          }),
        );
        return;
      }
      res.statusCode = 202;
      res.end(JSON.stringify({ taskUid: 1, indexUid: 'products', status: 'enqueued' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

    const { port } = server.address() as AddressInfo;
    adapter = new MeilisearchCatalogSearch(
      fakeConfigService({ 'search.enabled': true, 'search.url': `http://127.0.0.1:${port}` }),
      fakePinoLogger(),
    );
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('resolves when the engine applied the write', async () => {
    taskStatus = 'succeeded';
    await expect(adapter.indexProduct(DOC)).resolves.toBeUndefined();
    await expect(adapter.deleteProduct('p1')).resolves.toBeUndefined();
    await expect(adapter.bulkIndex([DOC])).resolves.toBeUndefined();
  });

  it('rejects when the engine rejected the write', async () => {
    taskStatus = 'failed';
    await expect(adapter.indexProduct(DOC)).rejects.toThrow('no space left on device');
    await expect(adapter.deleteProduct('p1')).rejects.toThrow('no space left on device');
    await expect(adapter.bulkIndex([DOC])).rejects.toThrow('no space left on device');
    await expect(adapter.resetIndex()).rejects.toThrow('no space left on device');
  });
});

describe('MeilisearchCatalogSearch (query construction)', () => {
  let server: http.Server;
  let adapter: MeilisearchCatalogSearch;
  type SearchRequestBody = {
    filter?: string[];
    limit?: number;
    offset?: number;
    q?: string;
    attributesToHighlight?: string[];
    highlightPreTag?: string;
    highlightPostTag?: string;
  };
  let lastQuery: SearchRequestBody;
  let hits: unknown[];
  let estimatedTotalHits: number;

  beforeEach(() => {
    hits = [];
    estimatedTotalHits = 42;
  });

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        lastQuery = JSON.parse(Buffer.concat(chunks).toString() || '{}') as SearchRequestBody;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ hits, estimatedTotalHits, query: lastQuery.q, processingTimeMs: 1 }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    adapter = new MeilisearchCatalogSearch(
      fakeConfigService({ 'search.enabled': true, 'search.url': `http://127.0.0.1:${port}` }),
      fakePinoLogger(),
    );
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('constrains every search to ACTIVE, so a document a failed delete left behind stays hidden', async () => {
    await adapter.search({ q: 'widget', page: 1, pageSize: 20 });

    expect(lastQuery.filter).toEqual(['status = "ACTIVE"']);
  });

  it('adds the category filter as a separate conjunct', async () => {
    await adapter.search({ q: 'widget', page: 1, pageSize: 20, categorySlug: 'tools' });

    expect(lastQuery.filter).toEqual(['status = "ACTIVE"', 'categorySlug = "tools"']);
  });

  it('escapes a quote in the category slug instead of letting it close the literal', async () => {
    await adapter.search({ q: 'widget', page: 1, pageSize: 20, categorySlug: 'tools" OR status = "DRAFT' });

    expect(lastQuery.filter).toEqual(['status = "ACTIVE"', 'categorySlug = "tools\\" OR status = \\"DRAFT"']);
  });

  // The backslash must be escaped first, or a trailing one escapes the closing quote instead.
  it('escapes a backslash before it can escape the closing quote', async () => {
    await adapter.search({ q: 'widget', page: 1, pageSize: 20, categorySlug: 'tools\\' });

    expect(lastQuery.filter).toEqual(['status = "ACTIVE"', 'categorySlug = "tools\\\\"']);
  });

  // An undeclared filter attribute makes the engine reject the whole query, and the swallowed error
  // then turns every search into an empty page.
  it('filters only on attributes the index declares filterable', async () => {
    await adapter.search({ q: 'widget', page: 1, pageSize: 20, categorySlug: 'tools' });

    const attributes = (lastQuery.filter ?? []).map((clause) => clause.split(' ')[0]);
    expect(attributes).not.toHaveLength(0);
    for (const attribute of attributes) {
      expect(PRODUCTS_INDEX_SETTINGS.filterableAttributes).toContain(attribute);
    }
  });

  it('asks the engine to highlight the attributes the response promises', async () => {
    await adapter.search({ q: 'widget', page: 1, pageSize: 20 });

    expect(lastQuery.attributesToHighlight).toEqual(['name', 'description']);
    expect(lastQuery.highlightPreTag).toBe('<em>');
    expect(lastQuery.highlightPostTag).toBe('</em>');
  });

  it('maps page and pageSize onto limit and offset', async () => {
    await adapter.search({ q: 'widget', page: 3, pageSize: 20 });

    expect(lastQuery.limit).toBe(20);
    expect(lastQuery.offset).toBe(40);
  });

  it('caps the reported total at the depth the engine will actually serve', async () => {
    estimatedTotalHits = 16_000;

    const result = await adapter.search({ q: 'widget', page: 1, pageSize: 20 });

    expect(result.total).toBe(SEARCH_MAX_TOTAL_HITS);
  });

  it('reads the total from the engine estimate and carries highlights through', async () => {
    hits = [{ ...DOC, _formatted: { name: 'Wid<em>get</em>' } }];

    const result = await adapter.search({ q: 'get', page: 1, pageSize: 20 });

    expect(result.total).toBe(42);
    expect(result.items).toEqual([
      {
        id: 'p1',
        name: 'Widget',
        slug: 'widget',
        categorySlug: 'tools',
        minPriceMinor: 1000,
        currency: 'VND',
        highlight: { name: 'Wid<em>get</em>', description: undefined },
      },
    ]);
  });
});

describe('MeilisearchCatalogSearch (engine failure degrades)', () => {
  it('resolves to an empty result when the engine refuses the connection', async () => {
    // Port 1 is privileged and unbound in the test environment, so the connection fails immediately.
    const adapter = new MeilisearchCatalogSearch(
      fakeConfigService({ 'search.enabled': true, 'search.url': 'http://127.0.0.1:1' }),
      fakePinoLogger(),
    );

    await expect(adapter.search({ q: 'widget', page: 1, pageSize: 20 })).resolves.toEqual({
      items: [],
      total: 0,
    });
  });

  it('resolves to an empty result when the engine answers with an error', async () => {
    const server = http.createServer((_req, res) => {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ message: 'internal', code: 'internal' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const adapter = new MeilisearchCatalogSearch(
      fakeConfigService({ 'search.enabled': true, 'search.url': `http://127.0.0.1:${port}` }),
      fakePinoLogger(),
    );

    try {
      await expect(adapter.search({ q: 'widget', page: 1, pageSize: 20 })).resolves.toEqual({
        items: [],
        total: 0,
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
