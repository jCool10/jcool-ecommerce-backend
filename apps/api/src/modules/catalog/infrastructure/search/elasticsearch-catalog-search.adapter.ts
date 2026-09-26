import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client, type estypes } from '@elastic/elasticsearch';
import { PinoLogger } from 'nestjs-pino';
import type { OutboundCall } from '@jcool/platform/resilience';
import {
  type CatalogSearchPort,
  RebuildInProgressError,
  type SearchCriteria,
  type SearchDocumentWrite,
  type SearchHit,
  type SearchResult,
  type SearchableProduct,
} from '../../application/ports';
import {
  PRODUCTS_ALIAS,
  PRODUCTS_INDEX_DEFINITION,
  PRODUCTS_INDEX_PREFIX,
  REBUILD_ALIAS,
  SEARCH_MAX_TOTAL_HITS,
} from './index-settings';
import { SearchEngineError, assertApplied, logShapeOf, withoutRequest } from './search-engine-error';

export const SEARCH_ENGINE_CALLS = Symbol('SEARCH_ENGINE_CALLS');
export const SEARCH_READ_BREAKER = 'elasticsearch-read';
export const SEARCH_WRITE_BREAKER = 'elasticsearch-write';

// Apart because the engine can refuse writes (shed bulk items, a full disk) while still answering
// queries; one breaker would then blank public search over a write-side fault.
export interface SearchEngineCalls {
  read: OutboundCall;
  write: OutboundCall;
}

const LOG_CONTEXT = 'ElasticsearchCatalogSearch';

const INITIAL_INDEX = `${PRODUCTS_INDEX_PREFIX}0`;
const WRITE_CHUNK = 500;
const EMPTY: SearchResult = { items: [], total: 0 };
const INDEX_NOT_FOUND = 'index_not_found_exception';
// What releasing a lock answers when the swap or another abort got there first.
const GONE = new Set(['aliases_not_found_exception', INDEX_NOT_FOUND]);

// Never matches the read filter, so a tombstone holds its version without ever being served.
const TOMBSTONE_STATUS = 'INACTIVE';

const SEARCH_FIELDS = ['name^4', 'skus^3', 'categoryName^2', 'description'];
// The id tiebreak keeps equal scores in one order across pages; doc order shifts on every merge.
const SORT: estypes.Sort = [{ _score: { order: 'desc' } }, { id: { order: 'asc' } }];
const HIGHLIGHT: estypes.SearchHighlight = {
  number_of_fragments: 0,
  pre_tags: ['<em>'],
  post_tags: ['</em>'],
  fields: { name: {}, description: {} },
};

function unlessAlreadyExists(error: unknown): void {
  if (!(error instanceof SearchEngineError && error.type === 'resource_already_exists_exception')) {
    throw error;
  }
}

/**
 * `SEARCH_ENABLED=false` leaves the client unbuilt and every method a no-op, so dev and unit tests
 * need no engine. `search` degrades to an empty page (an optional read must never 5xx over data
 * Postgres can serve); the writes reject so their caller can retry.
 */
@Injectable()
export class ElasticsearchCatalogSearch implements CatalogSearchPort, OnApplicationShutdown {
  private readonly client: Client | null;
  // Half the request timeout, so a slow shard answers with the hits it has before the call is abandoned.
  private readonly searchTimeout: string;

  // Explicit @Inject rather than type reflection: the reindex CLI builds this under tsx/esbuild,
  // which emits no decorator metadata, so an inferred constructor type resolves to undefined there.
  constructor(
    @Inject(ConfigService) config: ConfigService,
    @Inject(SEARCH_ENGINE_CALLS) private readonly calls: SearchEngineCalls,
    @Inject(PinoLogger) private readonly logger: PinoLogger,
  ) {
    logger.setContext(LOG_CONTEXT);
    const enabled = config.get<boolean>('search.enabled') ?? false;
    const requestTimeout = enabled ? config.getOrThrow<number>('search.requestTimeoutMs') : 0;
    const password = config.get<string>('search.password');
    this.searchTimeout = `${Math.floor(requestTimeout / 2)}ms`;
    this.client = enabled
      ? new Client({
          node: config.getOrThrow<string>('search.url'),
          ...(password && { auth: { username: config.getOrThrow<string>('search.username'), password } }),
          // v9 has no default, so a hung engine would hold its caller forever.
          requestTimeout,
          // Retries belong to the caller; one inside the client outlives the breaker's timeout.
          maxRetries: 0,
        })
      : null;
  }

  async onApplicationShutdown(): Promise<void> {
    await this.client?.close();
  }

  async ensureIndex(): Promise<void> {
    const client = this.client;
    if (!client) return;

    const write = this.calls.write;
    if (!(await this.call(write, () => client.indices.existsAlias({ name: PRODUCTS_ALIAS })))) {
      // Replicas booting together race to create it; the losers only add the alias.
      await this.call(write, () => client.indices.create({ index: INITIAL_INDEX, ...PRODUCTS_INDEX_DEFINITION })).catch(
        unlessAlreadyExists,
      );
      await this.call(write, () =>
        client.indices.putAlias({ index: INITIAL_INDEX, name: PRODUCTS_ALIAS, is_write_index: true }),
      );
    }
    // Also after a create, since the index that already existed may predate the current fields.
    // Additive only: a changed type or analyzer fails here and needs a rebuild.
    await this.call(write, () =>
      client.indices.putMapping({ index: PRODUCTS_ALIAS, properties: PRODUCTS_INDEX_DEFINITION.mappings.properties }),
    );
  }

  async write(changes: SearchDocumentWrite[]): Promise<void> {
    // The rebuild alias exists only while a rebuild runs, so its copy failing as missing is the normal case.
    await this.bulkWrite(changes, [PRODUCTS_ALIAS, REBUILD_ALIAS], REBUILD_ALIAS);
  }

  async writeRebuild(changes: SearchDocumentWrite[]): Promise<void> {
    await this.bulkWrite(changes, [REBUILD_ALIAS]);
  }

  async beginRebuild(): Promise<string> {
    const client = this.client;
    if (!client) return '';

    const write = this.calls.write;
    const rebuilding = () => this.call(write, () => client.indices.existsAlias({ name: REBUILD_ALIAS }));
    if (await rebuilding()) throw new RebuildInProgressError();
    const index = `${PRODUCTS_INDEX_PREFIX}${Date.now()}`;
    await this.call(write, () =>
      client.indices.create({
        index,
        ...PRODUCTS_INDEX_DEFINITION,
        // As the write index, the engine refuses to put the alias on a second one, which closes the
        // gap between the check above and this create.
        aliases: { [REBUILD_ALIAS]: { is_write_index: true } },
      }),
    ).catch(async (error: unknown) => {
      if (await rebuilding()) throw new RebuildInProgressError();
      throw error;
    });
    return index;
  }

  async promoteRebuild(rebuild: string): Promise<string[]> {
    const client = this.client;
    if (!client) return [];

    const write = this.calls.write;
    const indices = await this.physicalIndices(client);
    // Cleared by --clear-stale while this run was filling; the lock may now be another run's.
    if (!indices.some(({ name, aliases }) => name === rebuild && aliases.includes(REBUILD_ALIAS))) {
      throw new Error(`${rebuild} no longer holds the rebuild lock`);
    }
    const serving = indices.filter(({ aliases }) => aliases.includes(PRODUCTS_ALIAS)).map(({ name }) => name);

    // Otherwise the last pages stay invisible to search until the engine's next periodic refresh.
    await this.call(write, () => client.indices.refresh({ index: rebuild }));
    await this.call(write, () =>
      client.indices.updateAliases({
        // must_exist on every remove: without it the engine applies the other actions around an alias
        // that moved since the read above, instead of refusing the whole swap.
        actions: [
          ...serving.map((index) => ({ remove: { index, alias: PRODUCTS_ALIAS, must_exist: true } })),
          { add: { index: rebuild, alias: PRODUCTS_ALIAS, is_write_index: true } },
          { remove: { index: rebuild, alias: REBUILD_ALIAS, must_exist: true } },
        ],
      }),
    );
    return indices.map(({ name }) => name).filter((name) => name !== rebuild);
  }

  async abortRebuild(rebuild?: string): Promise<void> {
    const client = this.client;
    if (!client) return;

    const write = this.calls.write;
    const locked = (await this.physicalIndices(client)).filter(
      ({ name, aliases }) =>
        (rebuild === undefined || name === rebuild) &&
        aliases.includes(REBUILD_ALIAS) &&
        !aliases.includes(PRODUCTS_ALIAS),
    );
    for (const { name } of locked) {
      // Deleted only once the release went through: the engine applies either the release or a swap still
      // in flight, never both, so an index the swap moved search onto is kept.
      const released = await this.call(write, () =>
        client.indices.updateAliases({
          actions: [{ remove: { index: name, alias: REBUILD_ALIAS, must_exist: true } }],
        }),
      ).then(
        () => true,
        (error: unknown) => {
          if (error instanceof SearchEngineError && GONE.has(error.type)) return false;
          throw error;
        },
      );
      if (released) await this.call(write, () => client.indices.delete({ index: name }));
    }
  }

  async dropRetired(indices: string[]): Promise<void> {
    const client = this.client;
    if (!client) return;

    // Re-read rather than trust the list: an index behind any alias, or outside the prefix, stays.
    const idle = new Set(
      (await this.physicalIndices(client)).filter(({ aliases }) => aliases.length === 0).map(({ name }) => name),
    );
    const doomed = indices.filter((index) => idle.has(index));
    if (doomed.length > 0) {
      await this.call(this.calls.write, () => client.indices.delete({ index: doomed }));
    }
  }

  async search(criteria: SearchCriteria): Promise<SearchResult> {
    const client = this.client;
    if (!client) return EMPTY;

    try {
      const response = await this.call(this.calls.read, () =>
        client.search<SearchableProduct>(this.searchRequest(criteria)),
      );
      const total = response.hits.total;
      return {
        items: response.hits.hits.flatMap((hit) => (hit._source ? [toSearchHit(hit._source, hit.highlight)] : [])),
        total: Math.min(typeof total === 'number' ? total : (total?.value ?? 0), SEARCH_MAX_TOTAL_HITS),
      };
    } catch (error) {
      this.logger.warn({ error: logShapeOf(error) }, 'catalog search failed');
      return EMPTY;
    }
  }

  private searchRequest(criteria: SearchCriteria): estypes.SearchRequest {
    const from = (criteria.page - 1) * criteria.pageSize;
    const request: estypes.SearchRequest = {
      index: PRODUCTS_ALIAS,
      query: {
        bool: {
          must: {
            multi_match: {
              query: criteria.q,
              type: 'best_fields',
              fields: SEARCH_FIELDS,
              fuzziness: 'AUTO',
              prefix_length: 1,
              max_expansions: 20,
            },
          },
          filter: [
            { term: { status: 'ACTIVE' } },
            ...(criteria.categorySlug ? [{ term: { categorySlug: criteria.categorySlug } }] : []),
          ],
        },
      },
      track_total_hits: SEARCH_MAX_TOTAL_HITS,
      timeout: this.searchTimeout,
    };
    // The engine refuses a page past the window; a count still answers the total the caller pages by.
    if (from >= SEARCH_MAX_TOTAL_HITS) {
      return { ...request, size: 0 };
    }
    return {
      ...request,
      from,
      size: Math.min(criteria.pageSize, SEARCH_MAX_TOTAL_HITS - from),
      sort: SORT,
      highlight: HIGHLIGHT,
    };
  }

  private async bulkWrite(
    changes: SearchDocumentWrite[],
    targets: readonly string[],
    mayBeMissing?: string,
  ): Promise<void> {
    const client = this.client;
    if (!client) return;

    for (let offset = 0; offset < changes.length; offset += WRITE_CHUNK) {
      const chunk = changes.slice(offset, offset + WRITE_CHUNK);
      await this.call(this.calls.write, async () => {
        const response = await client.bulk({
          // A missing alias fails the write instead of auto-creating a bare index under its name.
          require_alias: true,
          operations: chunk.flatMap((change) =>
            targets.flatMap((index) => [
              { index: { _index: index, _id: change.id, version: change.version, version_type: 'external' as const } },
              change.doc ?? { id: change.id, status: TOMBSTONE_STATUS },
            ]),
          ),
        });
        // Inside the call: items shed under load come back in a 200, and the breaker must still count them.
        assertApplied(
          response,
          chunk.length,
          (error, position) => targets[position % targets.length] === mayBeMissing && error.type === INDEX_NOT_FOUND,
        );
      });
    }
  }

  private async physicalIndices(client: Client): Promise<{ name: string; aliases: string[] }[]> {
    const found = await this.call(this.calls.write, () =>
      client.indices.getAlias({ index: `${PRODUCTS_INDEX_PREFIX}*` }),
    );
    return Object.entries(found).map(([name, { aliases }]) => ({ name, aliases: Object.keys(aliases) }));
  }

  private async call<T>(through: OutboundCall, task: () => Promise<T>): Promise<T> {
    try {
      return await through.run(task);
    } catch (error) {
      throw withoutRequest(error);
    }
  }
}

// The engine highlights only the fields that matched; the rest keep their plain text.
function toSearchHit(source: SearchableProduct, highlight: Record<string, string[]> | undefined): SearchHit {
  return {
    id: source.id,
    name: source.name,
    slug: source.slug,
    categorySlug: source.categorySlug,
    minPriceMinor: source.minPriceMinor,
    currency: source.currency,
    highlight: {
      name: highlight?.name?.[0] ?? source.name,
      description: highlight?.description?.[0] ?? source.description ?? undefined,
    },
  };
}
