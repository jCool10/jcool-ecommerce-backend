import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Meilisearch, type Index } from 'meilisearch';
import type {
  CatalogSearchPort,
  SearchCriteria,
  SearchHit,
  SearchResult,
  SearchableProduct,
} from '../../application/ports';
import {
  PRODUCTS_INDEX_PRIMARY_KEY,
  PRODUCTS_INDEX_SETTINGS,
  PRODUCTS_INDEX_UID,
  SEARCH_MAX_TOTAL_HITS,
} from './index-settings';

const HIGHLIGHT_PRE_TAG = '<em>';
const HIGHLIGHT_POST_TAG = '</em>';

// Caps one addDocuments payload: bulkIndex takes an unbounded array, so a caller may hand over far
// more than the reindexer's page size.
const BULK_INDEX_CHUNK = 1000;

// Only ACTIVE products are ever indexed, but a delete that failed while the engine was unreachable
// leaves its document behind until a reset reindex prunes it. Filtering on read means a product that
// left the public projection stops being findable immediately, without waiting for that convergence.
const ACTIVE_ONLY_FILTER = 'status = "ACTIVE"';

type FormattedHit = SearchableProduct & { _formatted?: Partial<SearchableProduct> };

type SettledTask = { status: string; error?: { message?: string } | null };

/**
 * `waitTask()` resolves for EVERY terminal task, `failed` included, so without this an out-of-space
 * or unknown-index rejection is indistinguishable from a successful write — a full reindex would
 * report a count it never actually stored.
 */
async function settled(pending: { waitTask: () => Promise<SettledTask> }): Promise<void> {
  const task = await pending.waitTask();
  if (task.status !== 'succeeded') {
    throw new Error(`search engine task ${task.status}: ${task.error?.message ?? 'no error detail'}`);
  }
}

/**
 * The engine parses a filter as an expression, so an unescaped quote inside a value ends the literal
 * and turns the rest of the caller's string into filter syntax — enough to bolt an `OR` onto the
 * query. Escaping keeps a value a value.
 */
function quoted(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * `SEARCH_ENABLED=false` leaves the client unbuilt and every method a no-op, so dev and unit tests
 * need no engine. `search` swallows engine errors (an optional read must never 5xx over data
 * Postgres can serve); the write methods let errors propagate so the caller owns the best-effort
 * decision.
 */
@Injectable()
export class MeilisearchCatalogSearch implements CatalogSearchPort {
  private readonly logger = new Logger(MeilisearchCatalogSearch.name);
  // Stateless HTTP client — nothing to open or close, hence no shutdown hook.
  private readonly client: Meilisearch | null;

  // Explicit @Inject rather than type reflection: the reindex CLI builds this under tsx/esbuild,
  // which emits no decorator metadata, so an inferred constructor type resolves to undefined there.
  constructor(@Inject(ConfigService) config: ConfigService) {
    const enabled = config.get<boolean>('search.enabled') ?? false;
    this.client = enabled
      ? new Meilisearch({
          host: config.getOrThrow<string>('search.url'),
          apiKey: config.get<string>('search.apiKey'),
        })
      : null;
  }

  private index(): Index<SearchableProduct> | null {
    return this.client?.index<SearchableProduct>(PRODUCTS_INDEX_UID) ?? null;
  }

  async ensureIndex(): Promise<void> {
    if (!this.client) return;
    // createIndex enqueues a task that fails harmlessly when the index already exists; tolerate that
    // and always (re)apply settings, which is itself idempotent — a real down-engine error still
    // surfaces from updateSettings below.
    await this.client
      .createIndex(PRODUCTS_INDEX_UID, { primaryKey: PRODUCTS_INDEX_PRIMARY_KEY })
      .waitTask()
      .catch(() => undefined);
    await settled(this.client.index(PRODUCTS_INDEX_UID).updateSettings(PRODUCTS_INDEX_SETTINGS));
  }

  async resetIndex(): Promise<void> {
    const index = this.index();
    if (!index) return;
    await settled(index.deleteAllDocuments());
  }

  async bulkIndex(docs: SearchableProduct[]): Promise<void> {
    const index = this.index();
    if (!index || docs.length === 0) return;
    for (let offset = 0; offset < docs.length; offset += BULK_INDEX_CHUNK) {
      const chunk = docs.slice(offset, offset + BULK_INDEX_CHUNK);
      await settled(index.addDocuments(chunk, { primaryKey: PRODUCTS_INDEX_PRIMARY_KEY }));
    }
  }

  async indexProduct(doc: SearchableProduct): Promise<void> {
    const index = this.index();
    if (!index) return;
    await settled(index.addDocuments([doc], { primaryKey: PRODUCTS_INDEX_PRIMARY_KEY }));
  }

  async deleteProduct(id: string): Promise<void> {
    const index = this.index();
    if (!index) return;
    await settled(index.deleteDocument(id));
  }

  async search(criteria: SearchCriteria): Promise<SearchResult> {
    const index = this.index();
    if (!index) return { items: [], total: 0 };

    try {
      const filter = [ACTIVE_ONLY_FILTER];
      if (criteria.categorySlug) {
        filter.push(`categorySlug = ${quoted(criteria.categorySlug)}`);
      }

      const response = await index.search(criteria.q, {
        limit: criteria.pageSize,
        offset: (criteria.page - 1) * criteria.pageSize,
        // Separate array entries are ANDed, so the status constraint cannot be widened by whatever
        // the category filter turns out to match.
        filter,
        attributesToHighlight: ['name', 'description'],
        highlightPreTag: HIGHLIGHT_PRE_TAG,
        highlightPostTag: HIGHLIGHT_POST_TAG,
      });

      return {
        items: response.hits.map(toSearchHit),
        // The engine only serves the first SEARCH_MAX_TOTAL_HITS of what it reports as matching, so
        // the raw estimate would advertise pages that always come back empty.
        total: Math.min(response.estimatedTotalHits ?? response.hits.length, SEARCH_MAX_TOTAL_HITS),
      };
    } catch (err) {
      this.logger.warn(`catalog search failed: ${err instanceof Error ? err.message : String(err)}`);
      return { items: [], total: 0 };
    }
  }
}

function toSearchHit(hit: FormattedHit): SearchHit {
  const name = hit._formatted?.name ?? undefined;
  const description = hit._formatted?.description ?? undefined;
  const highlight = name !== undefined || description !== undefined ? { name, description } : undefined;

  return {
    id: hit.id,
    name: hit.name,
    slug: hit.slug,
    categorySlug: hit.categorySlug,
    minPriceMinor: hit.minPriceMinor,
    currency: hit.currency,
    highlight,
  };
}
