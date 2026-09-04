import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ConfigService } from '@nestjs/config';
import type { SearchableProduct } from '../../application/ports';
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
