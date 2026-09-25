import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { errors } from '@elastic/elasticsearch';
import { DownstreamUnavailableError, type OutboundCall } from '@jcool/platform/resilience';
import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { vi } from 'vitest';
import type { SearchCriteria, SearchDocumentWrite, SearchableProduct } from '../../application/ports';
import {
  ElasticsearchCatalogSearch,
  SEARCH_READ_BREAKER,
  SEARCH_WRITE_BREAKER,
  type SearchEngineCalls,
} from './elasticsearch-catalog-search.adapter';
import { REBUILD_ALIAS, SEARCH_MAX_TOTAL_HITS } from './index-settings';
import { SearchEngineError, isSearchEngineFault } from './search-engine-error';

const DOC: SearchableProduct = {
  id: 'p1',
  name: 'Widget',
  slug: 'widget',
  description: 'A widget for work',
  categorySlug: 'tools',
  categoryName: 'Tools',
  status: 'ACTIVE',
  skus: ['WIDGET-1'],
  minPriceMinor: 1000,
  currency: 'VND',
  createdAtEpoch: 0,
};

const QUERY: SearchCriteria = { q: 'widget', page: 1, pageSize: 20 };

const passThrough: OutboundCall = { run: (task) => task() };
const refusing = (breaker: string): OutboundCall => ({
  run: () => Promise.reject(new DownstreamUnavailableError(breaker, 'open')),
});

const live = (id: string, version: number): SearchDocumentWrite => ({ id, version, doc: { ...DOC, id } });

const enabledConfig = (url: string) =>
  fakeConfigService({
    'search.enabled': true,
    'search.url': url,
    'search.username': 'elastic',
    'search.password': 'unit-test-password-not-a-secret',
    'search.requestTimeoutMs': 2_000,
  });

interface EngineRequest {
  path: string;
  body: string;
}

interface Reply {
  status?: number;
  body: unknown;
}

/** A stand-in engine on a random port: `respond` answers every request, and requests are recorded. */
async function startEngine(respond: (request: EngineRequest) => Reply, calls: Partial<SearchEngineCalls> = {}) {
  const requests: EngineRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const request = { path: req.url ?? '', body: Buffer.concat(chunks).toString() };
      requests.push(request);
      const reply = respond(request);
      res.statusCode = reply.status ?? 200;
      // The client rejects any answer that does not carry it.
      res.setHeader('x-elastic-product', 'Elasticsearch');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const warn = vi.fn();
  const adapter = new ElasticsearchCatalogSearch(
    enabledConfig(`http://127.0.0.1:${port}`),
    { read: calls.read ?? passThrough, write: calls.write ?? passThrough },
    fakePinoLogger({ warn }),
  );
  const stop = async () => {
    await adapter.onApplicationShutdown();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  const searchBodies = () =>
    requests
      .filter((request) => request.path.includes('/_search'))
      .map((request) => JSON.parse(request.body) as object);
  return { adapter, requests, searchBodies, warn, stop };
}

const ndjson = (body: string): unknown[] =>
  body
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);

interface ItemOutcome {
  status: number;
  errorType?: string;
}

const created: ItemOutcome = { status: 201 };
const aliasMissing: ItemOutcome = { status: 404, errorType: 'index_not_found_exception' };

// A live-alias item answered by `outcome`; the rebuild item answered as if no rebuild runs.
const onLiveItems =
  (outcome: (id: string) => ItemOutcome) =>
  (index: string, id: string): ItemOutcome =>
    index === REBUILD_ALIAS ? aliasMissing : outcome(id);

// What the engine answers while no rebuild runs: the rebuild alias does not exist.
const noRebuild = onLiveItems(() => created);

interface BulkAction {
  index: { _index: string; _id: string };
}

// Bulk lines alternate action and document; only an action carries `index`.
const isAction = (line: unknown): line is BulkAction => typeof line === 'object' && line !== null && 'index' in line;

/** Answers each item of the bulk request in order, as `outcome` decides it by target alias and id. */
const bulkReply =
  (outcome: (index: string, id: string) => ItemOutcome = noRebuild) =>
  (request: EngineRequest): Reply => {
    const items = ndjson(request.body)
      .filter(isAction)
      .map(({ index: { _index, _id } }) => {
        const { status, errorType } = outcome(_index, _id);
        return {
          index: {
            _index,
            _id,
            status,
            ...(errorType ? { error: { type: errorType, reason: `${errorType} for ${_id}` } } : { result: 'created' }),
          },
        };
      });
    return { body: { took: 1, errors: items.some((item) => 'error' in item.index), items } };
  };

const versioned = (index: string, id: string, version: number) => ({
  index: { _index: index, _id: id, version, version_type: 'external' },
});

const searchReply = (total: number, hits: object[]): Reply => ({
  body: {
    took: 1,
    timed_out: false,
    _shards: { total: 1, successful: 1, skipped: 0, failed: 0 },
    hits: {
      total: { value: total, relation: 'gte' },
      max_score: 1,
      hits: hits.map((hit) => ({ _index: 'products_v0', _score: 1, ...hit })),
    },
  },
});

describe('ElasticsearchCatalogSearch', () => {
  it('does nothing and finds nothing when search is disabled', async () => {
    const run = vi.fn();
    const adapter = new ElasticsearchCatalogSearch(
      fakeConfigService({ 'search.enabled': false }),
      { read: { run }, write: { run } },
      fakePinoLogger(),
    );

    await expect(adapter.search(QUERY)).resolves.toEqual({ items: [], total: 0 });
    await expect(
      Promise.all([
        adapter.ensureIndex(),
        adapter.write([live('p1', 1)]),
        adapter.beginRebuild(),
        adapter.writeRebuild([live('p1', 1)]),
        adapter.promoteRebuild('products_v1'),
        adapter.abortRebuild(),
        adapter.dropRetired(['products_v0']),
      ]),
    ).resolves.toEqual([undefined, undefined, '', undefined, [], undefined, undefined]);
    expect(run).not.toHaveBeenCalled();
  });

  describe('write', () => {
    it('writes each change at its row version to search and to a rebuild, and a tombstone for a hidden product', async () => {
      const engine = await startEngine(bulkReply());
      try {
        await engine.adapter.write([live('p1', 3), { id: 'p2', version: 4, doc: null }]);
      } finally {
        await engine.stop();
      }

      const [bulk] = engine.requests;
      expect(bulk.path).toMatch(/^\/_bulk\?.*require_alias=true/);
      expect(ndjson(bulk.body)).toEqual([
        versioned('products', 'p1', 3),
        { ...DOC, id: 'p1' },
        versioned(REBUILD_ALIAS, 'p1', 3),
        { ...DOC, id: 'p1' },
        versioned('products', 'p2', 4),
        { id: 'p2', status: 'INACTIVE' },
        versioned(REBUILD_ALIAS, 'p2', 4),
        { id: 'p2', status: 'INACTIVE' },
      ]);
    });

    it('sends at most 500 documents per request', async () => {
      const engine = await startEngine(bulkReply());
      try {
        await engine.adapter.write(Array.from({ length: 1_001 }, (_, i) => live(`p${i}`, 1)));
      } finally {
        await engine.stop();
      }

      expect(engine.requests.map((request) => ndjson(request.body).length / 4)).toEqual([500, 500, 1]);
    });

    it('ignores a missing rebuild alias, and never a missing search alias', async () => {
      const engine = await startEngine(bulkReply(noRebuild));
      try {
        await expect(engine.adapter.write([live('p1', 1)])).resolves.toBeUndefined();
      } finally {
        await engine.stop();
      }

      const lost = await startEngine(bulkReply(() => aliasMissing));
      try {
        await expect(lost.adapter.write([live('p1', 1)])).rejects.toMatchObject({
          type: 'index_not_found_exception',
          statusCode: 404,
        });
      } finally {
        await lost.stop();
      }
    });

    // A redelivery or a replay carries a version the engine already holds; refusing it is the point.
    it('resolves when the only item failures are version conflicts', async () => {
      const conflict: ItemOutcome = { status: 409, errorType: 'version_conflict_engine_exception' };
      const engine = await startEngine(bulkReply((_, id) => (id === 'p2' ? conflict : created)));
      try {
        await expect(engine.adapter.write([live('p1', 1), live('p2', 1)])).resolves.toBeUndefined();
      } finally {
        await engine.stop();
      }
    });

    it('rejects any other item failure with its type and the documents refused', async () => {
      const outcomes: Record<string, ItemOutcome> = {
        p2: { status: 409, errorType: 'version_conflict_engine_exception' },
        p3: { status: 400, errorType: 'strict_dynamic_mapping_exception' },
      };
      const byId = (id: string) => outcomes[id] ?? created;
      for (const outcome of [onLiveItems(byId), (_: string, id: string) => byId(id)]) {
        const engine = await startEngine(bulkReply(outcome));
        try {
          const rejection = engine.adapter.write([live('p1', 1), live('p2', 1), live('p3', 1)]);

          await expect(rejection).rejects.toMatchObject({ type: 'strict_dynamic_mapping_exception', statusCode: 400 });
          // Counted by document: during a rebuild both of its items fail.
          await expect(rejection).rejects.toThrow('1 of 3');
        } finally {
          await engine.stop();
        }
      }
    });

    // Only a missing rebuild alias is expected; a rebuild copy shed under load would leave the new index behind.
    it('rejects when the rebuild copy fails for any other reason, even though search took the change', async () => {
      const shed: ItemOutcome = { status: 429, errorType: 'es_rejected_execution_exception' };
      const engine = await startEngine(bulkReply((index) => (index === REBUILD_ALIAS ? shed : created)));
      try {
        await expect(engine.adapter.write([live('p1', 1)])).rejects.toMatchObject({
          type: 'es_rejected_execution_exception',
          statusCode: 429,
        });
      } finally {
        await engine.stop();
      }
    });

    // Bulk answers 200 when the engine sheds items under load, so the breaker only learns of it if the
    // item failure is thrown inside the call.
    it('fails inside the breaker, blaming the engine for a shed item and not for a refused document', async () => {
      const refused: ItemOutcome = { status: 400, errorType: 'strict_dynamic_mapping_exception' };
      const shed: ItemOutcome = { status: 429, errorType: 'es_rejected_execution_exception' };
      const breakerSaw = async (outcomes: ItemOutcome[]) => {
        const failures: unknown[] = [];
        const recording: OutboundCall = {
          run: async (task) => {
            try {
              return await task();
            } catch (error) {
              failures.push(error);
              throw error;
            }
          },
        };
        const engine = await startEngine(bulkReply(onLiveItems((id) => outcomes[Number(id.slice(1))])), {
          write: recording,
        });
        try {
          await engine.adapter.write(outcomes.map((_, i) => live(`p${i}`, 1))).catch(() => undefined);
        } finally {
          await engine.stop();
        }
        return failures.map((failure) => ({
          type: failure instanceof SearchEngineError ? failure.type : undefined,
          fault: isSearchEngineFault(failure),
        }));
      };

      expect(await breakerSaw([refused])).toEqual([{ type: 'strict_dynamic_mapping_exception', fault: false }]);
      expect(await breakerSaw([refused, shed])).toEqual([{ type: 'es_rejected_execution_exception', fault: true }]);
    });
  });

  describe('writeRebuild', () => {
    it('writes each change at its row version to the rebuild only', async () => {
      const engine = await startEngine(bulkReply(() => created));
      try {
        await engine.adapter.writeRebuild([live('p1', 3), { id: 'p2', version: 4, doc: null }]);
      } finally {
        await engine.stop();
      }

      const [bulk] = engine.requests;
      expect(bulk.path).toMatch(/^\/_bulk\?.*require_alias=true/);
      expect(ndjson(bulk.body)).toEqual([
        versioned(REBUILD_ALIAS, 'p1', 3),
        { ...DOC, id: 'p1' },
        versioned(REBUILD_ALIAS, 'p2', 4),
        { id: 'p2', status: 'INACTIVE' },
      ]);
    });

    // The rebuild was aborted under it, so the fill must stop rather than report success.
    it('rejects when the rebuild alias is gone', async () => {
      const engine = await startEngine(bulkReply());
      try {
        await expect(engine.adapter.writeRebuild([live('p1', 1)])).rejects.toMatchObject({
          type: 'index_not_found_exception',
        });
      } finally {
        await engine.stop();
      }
    });
  });

  it('counts connection errors, timeouts, 5xx and 429 against the engine, and no other 4xx', () => {
    const answered = (statusCode: number) =>
      new errors.ResponseError({
        body: { error: { type: 'some_exception' }, status: statusCode },
        statusCode,
        headers: {},
        warnings: null,
        meta: {} as never,
      });

    const itemFailed = (statusCode: number) => new SearchEngineError('some_exception', statusCode, 'refused');

    expect(
      [
        new errors.ConnectionError('connect ECONNREFUSED'),
        new errors.TimeoutError('Request timed out'),
        answered(500),
        answered(429),
        itemFailed(503),
        itemFailed(429),
      ].map(isSearchEngineFault),
    ).toEqual([true, true, true, true, true, true]);
    expect([answered(400), answered(404), itemFailed(400)].map(isSearchEngineFault)).toEqual([false, false, false]);
  });

  it('answers an empty page while the read breaker is open and still lands writes', async () => {
    const engine = await startEngine(bulkReply(), { read: refusing(SEARCH_READ_BREAKER) });
    try {
      await expect(engine.adapter.write([live('p1', 1)])).resolves.toBeUndefined();
      await expect(engine.adapter.search(QUERY)).resolves.toEqual({ items: [], total: 0 });
    } finally {
      await engine.stop();
    }

    expect(engine.requests.map((request) => request.path.split('?')[0])).toEqual(['/_bulk']);
  });

  // Shed bulk items or a full disk refuse writes on a cluster that still answers queries.
  it('fails writes, provisioning and rebuilds while the write breaker is open and still serves search', async () => {
    const engine = await startEngine(() => searchReply(1, [{ _id: 'p1', _source: { ...DOC, id: 'p1' } }]), {
      write: refusing(SEARCH_WRITE_BREAKER),
    });
    try {
      expect((await engine.adapter.search(QUERY)).items.map((hit) => hit.id)).toEqual(['p1']);
      for (const call of [
        () => engine.adapter.write([live('p1', 1)]),
        () => engine.adapter.ensureIndex(),
        () => engine.adapter.beginRebuild(),
        () => engine.adapter.writeRebuild([live('p1', 1)]),
        () => engine.adapter.promoteRebuild('products_v1'),
        () => engine.adapter.abortRebuild('products_v1'),
        () => engine.adapter.abortRebuild(),
        () => engine.adapter.dropRetired(['products_v0']),
      ]) {
        await expect(call()).rejects.toBeInstanceOf(DownstreamUnavailableError);
      }
    } finally {
      await engine.stop();
    }

    expect(engine.searchBodies()).toHaveLength(1);
    expect(engine.requests).toHaveLength(1);
  });

  // The client's error carries the request, body and headers included.
  it('logs an engine error by its type, status and message only', async () => {
    const engine = await startEngine(() => ({
      status: 500,
      body: {
        error: {
          type: 'search_phase_execution_exception',
          reason: 'all shards failed',
          root_cause: [{ type: 'query_shard_exception', reason: 'failed to create query' }],
        },
        status: 500,
      },
    }));
    try {
      await expect(engine.adapter.search(QUERY)).resolves.toEqual({ items: [], total: 0 });
    } finally {
      await engine.stop();
    }

    expect(engine.warn).toHaveBeenCalledOnce();
    const [fields, message] = engine.warn.mock.calls[0] as [Record<string, { message: string }>, string];
    expect(message).toBe('catalog search failed');
    expect(fields).toEqual({
      error: { type: 'search_phase_execution_exception', statusCode: 500, message: fields.error.message },
    });
    expect(fields.error.message).toContain('failed to create query');
  });

  describe('search', () => {
    // The engine highlights matched fields only; the rest fall back to their plain text, so a client
    // always has a name to render.
    it('maps hits with a highlight on every text field and caps the total at the paging window', async () => {
      const engine = await startEngine(() =>
        searchReply(16_000, [
          {
            _id: 'p1',
            _source: DOC,
            highlight: { name: ['<em>Widget</em>'], description: ['A <em>widget</em> for work'] },
          },
          {
            _id: 'p2',
            _source: { ...DOC, id: 'p2', name: 'Gadget' },
            highlight: { description: ['A <em>widget</em> for work'] },
          },
          { _id: 'p3', _source: { ...DOC, id: 'p3', name: 'Gizmo', description: null } },
        ]),
      );
      try {
        const hit = { slug: 'widget', categorySlug: 'tools', minPriceMinor: 1000, currency: 'VND' };

        await expect(engine.adapter.search(QUERY)).resolves.toEqual({
          items: [
            {
              ...hit,
              id: 'p1',
              name: 'Widget',
              highlight: { name: '<em>Widget</em>', description: 'A <em>widget</em> for work' },
            },
            {
              ...hit,
              id: 'p2',
              name: 'Gadget',
              highlight: { name: 'Gadget', description: 'A <em>widget</em> for work' },
            },
            { ...hit, id: 'p3', name: 'Gizmo', highlight: { name: 'Gizmo', description: undefined } },
          ],
          total: SEARCH_MAX_TOTAL_HITS,
        });
      } finally {
        await engine.stop();
      }
    });

    it('clamps the last page to the window and asks only for a count past it', async () => {
      const engine = await startEngine(() => searchReply(SEARCH_MAX_TOTAL_HITS, []));
      try {
        for (const [page, pageSize] of [
          [10, 100],
          [20, 50],
          [39, 26],
          [11, 100],
        ]) {
          await engine.adapter.search({ q: 'widget', page, pageSize, categorySlug: 'tools' });
        }
        await expect(engine.adapter.search({ ...QUERY, page: 11, pageSize: 100 })).resolves.toEqual({
          items: [],
          total: SEARCH_MAX_TOTAL_HITS,
        });
      } finally {
        await engine.stop();
      }

      const bodies = engine.searchBodies() as { from?: number; size: number }[];
      expect(bodies.slice(0, 4).map(({ from, size }) => ({ from, size }))).toEqual([
        { from: 900, size: 100 },
        { from: 950, size: 50 },
        { from: 988, size: 12 },
        { from: undefined, size: 0 },
      ]);
      expect(bodies[0]).toMatchObject({
        track_total_hits: SEARCH_MAX_TOTAL_HITS,
        // Equal scores would otherwise tie by internal doc order, which a merge reshuffles between pages.
        sort: [{ _score: { order: 'desc' } }, { id: { order: 'asc' } }],
        highlight: { fields: { name: {}, description: {} } },
        query: { bool: { filter: [{ term: { status: 'ACTIVE' } }, { term: { categorySlug: 'tools' } }] } },
      });
      expect(Object.keys(bodies[3])).not.toContain('highlight');
      expect(Object.keys(bodies[3])).not.toContain('from');
    });
  });
});
