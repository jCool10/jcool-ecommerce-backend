import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import type { SearchableProduct } from '../../application/ports';
import { SEARCH_MAX_TOTAL_HITS } from './index-settings';
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

const QUERY = { q: 'widget', page: 1, pageSize: 20 };

/** A stand-in engine on a random port: `respond` answers every request, and bodies are recorded. */
async function startEngine(respond: (url: string, res: http.ServerResponse) => void) {
  const bodies: { filter?: string[] }[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      bodies.push(JSON.parse(Buffer.concat(chunks).toString() || '{}') as { filter?: string[] });
      res.setHeader('content-type', 'application/json');
      respond(req.url ?? '', res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const adapter = new MeilisearchCatalogSearch(
    fakeConfigService({ 'search.enabled': true, 'search.url': `http://127.0.0.1:${port}` }),
    fakePinoLogger(),
  );
  const stop = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return { adapter, bodies, stop };
}

const searchReply = (estimatedTotalHits: number) => (_url: string, res: http.ServerResponse) =>
  res.end(JSON.stringify({ hits: [], estimatedTotalHits, query: 'widget', processingTimeMs: 1 }));

describe('MeilisearchCatalogSearch', () => {
  it('does nothing and finds nothing when search is disabled', async () => {
    const adapter = new MeilisearchCatalogSearch(fakeConfigService({ 'search.enabled': false }), fakePinoLogger());

    await expect(adapter.search(QUERY)).resolves.toEqual({ items: [], total: 0 });
    await expect(
      Promise.all([
        adapter.ensureIndex(),
        adapter.resetIndex(),
        adapter.indexProduct(DOC),
        adapter.bulkIndex([DOC]),
        adapter.deleteProduct('p1'),
      ]),
    ).resolves.toEqual([undefined, undefined, undefined, undefined, undefined]);
  });

  // The engine accepts every write as a 202 task and `waitTask()` resolves for a failed task too,
  // so only the settled status says whether the document landed.
  it('rejects a write the engine accepted but then failed', async () => {
    const engine = await startEngine((url, res) => {
      if (url.startsWith('/tasks/')) {
        res.end(JSON.stringify({ uid: 1, status: 'failed', error: { message: 'no space left on device' } }));
        return;
      }
      res.statusCode = 202;
      res.end(JSON.stringify({ taskUid: 1, indexUid: 'products', status: 'enqueued' }));
    });

    try {
      await expect(engine.adapter.indexProduct(DOC)).rejects.toThrow('no space left on device');
      await expect(engine.adapter.deleteProduct('p1')).rejects.toThrow('no space left on device');
      await expect(engine.adapter.bulkIndex([DOC])).rejects.toThrow('no space left on device');
      await expect(engine.adapter.resetIndex()).rejects.toThrow('no space left on device');
    } finally {
      await engine.stop();
    }
  });

  // The HTTP edge rejects such a slug already; this keeps a non-HTTP caller from widening the filter.
  it('escapes quotes and backslashes in the category filter', async () => {
    const engine = await startEngine(searchReply(0));

    try {
      await engine.adapter.search({ ...QUERY, categorySlug: 'tools" OR status = "DRAFT' });
      await engine.adapter.search({ ...QUERY, categorySlug: 'tools\\' });
    } finally {
      await engine.stop();
    }

    expect(engine.bodies.map((body) => body.filter)).toEqual([
      ['status = "ACTIVE"', 'categorySlug = "tools\\" OR status = \\"DRAFT"'],
      ['status = "ACTIVE"', 'categorySlug = "tools\\\\"'],
    ]);
  });

  // Paging stops at the index's maxTotalHits; the raw estimate would advertise pages that come back
  // empty.
  it('caps the reported total at the depth the engine will serve', async () => {
    const engine = await startEngine(searchReply(16_000));

    try {
      await expect(engine.adapter.search(QUERY)).resolves.toMatchObject({ total: SEARCH_MAX_TOTAL_HITS });
    } finally {
      await engine.stop();
    }
  });

  it('answers an engine error with an empty result', async () => {
    const engine = await startEngine((_url, res) => {
      res.statusCode = 500;
      res.end(JSON.stringify({ message: 'internal', code: 'internal' }));
    });

    try {
      await expect(engine.adapter.search(QUERY)).resolves.toEqual({ items: [], total: 0 });
    } finally {
      await engine.stop();
    }
  });
});
