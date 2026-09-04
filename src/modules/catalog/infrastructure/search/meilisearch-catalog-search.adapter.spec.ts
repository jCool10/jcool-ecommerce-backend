import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ConfigService } from '@nestjs/config';
import type { SearchableProduct } from '../../application/ports';
import { PRODUCTS_INDEX_SETTINGS, SEARCH_MAX_TOTAL_HITS } from './index-settings';
import { MeilisearchCatalogSearch } from './meilisearch-catalog-search.adapter';

function configStub(values: Record<string, unknown>): ConfigService {
  return {
    get: (key: string) => values[key],
    getOrThrow: (key: string) => {
      const value = values[key];
      if (value === undefined) throw new Error(`missing config: ${key}`);
      return value;
    },
  } as unknown as ConfigService;
}

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

// SEARCH_ENABLED=false: no client is built, so every method short-circuits without touching an
// engine — the property that lets dev and unit runs skip Meilisearch entirely.
describe('MeilisearchCatalogSearch (disabled)', () => {
  const adapter = new MeilisearchCatalogSearch(configStub({ 'search.enabled': false }));

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

// The engine accepts a write as a task and reports the outcome only when that task settles, so an
// HTTP 202 says nothing about whether the document landed. These pin the write methods against a
// stub engine that settles the task either way.
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
      configStub({ 'search.enabled': true, 'search.url': `http://127.0.0.1:${port}` }),
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

  // waitTask() resolves for any settled task, so without an explicit status check a rejected write
  // reads exactly like a stored one and the caller's best-effort handler never runs.
  it('rejects when the engine rejected the write', async () => {
    taskStatus = 'failed';
    await expect(adapter.indexProduct(DOC)).rejects.toThrow('no space left on device');
    await expect(adapter.deleteProduct('p1')).rejects.toThrow('no space left on device');
    await expect(adapter.bulkIndex([DOC])).rejects.toThrow('no space left on device');
    await expect(adapter.resetIndex()).rejects.toThrow('no space left on device');
  });
});

// The query the adapter builds is what enforces public visibility on the read side, so these pin the
// request body the engine actually receives rather than the result it happens to return.
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
      configStub({ 'search.enabled': true, 'search.url': `http://127.0.0.1:${port}` }),
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

  // An unescaped quote would close the literal and let the rest of the value become filter syntax —
  // here an OR that would widen the ACTIVE constraint back off.
  it('escapes a quote in the category slug instead of letting it close the literal', async () => {
    await adapter.search({ q: 'widget', page: 1, pageSize: 20, categorySlug: 'tools" OR status = "DRAFT' });

    expect(lastQuery.filter).toEqual(['status = "ACTIVE"', 'categorySlug = "tools\\" OR status = \\"DRAFT"']);
  });

  // A trailing backslash would otherwise escape the closing quote and run the literal on into the
  // next clause, so the backslash itself has to be escaped first.
  it('escapes a backslash before it can escape the closing quote', async () => {
    await adapter.search({ q: 'widget', page: 1, pageSize: 20, categorySlug: 'tools\\' });

    expect(lastQuery.filter).toEqual(['status = "ACTIVE"', 'categorySlug = "tools\\\\"']);
  });

  // Every attribute the search filter names has to be declared filterable, or the engine rejects the
  // whole query and the swallowed error turns every search into an empty page.
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

  // The engine serves only the first SEARCH_MAX_TOTAL_HITS documents, so an uncapped estimate would
  // hand the caller a page count whose tail can never be fetched.
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

// Search is an extra read path over Postgres, so an engine that is unreachable or erroring has to
// degrade to an empty page. Letting the error out would turn a public endpoint into a 500 whenever
// the engine hiccups, which is exactly the coupling the port is written to avoid.
describe('MeilisearchCatalogSearch (engine failure degrades)', () => {
  it('resolves to an empty result when the engine refuses the connection', async () => {
    // Port 1 is privileged and unbound in the test environment, so the connection fails immediately.
    const adapter = new MeilisearchCatalogSearch(
      configStub({ 'search.enabled': true, 'search.url': 'http://127.0.0.1:1' }),
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
      configStub({ 'search.enabled': true, 'search.url': `http://127.0.0.1:${port}` }),
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
