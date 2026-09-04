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
import { PRODUCTS_INDEX_PRIMARY_KEY, PRODUCTS_INDEX_SETTINGS, PRODUCTS_INDEX_UID } from './index-settings';

const HIGHLIGHT_PRE_TAG = '<em>';
const HIGHLIGHT_POST_TAG = '</em>';

// Cap one addDocuments payload so a full reindex of a growing catalog never sends the whole table in
// a single request; the caller may still hand over more than a page at a time.
const BULK_INDEX_CHUNK = 1000;

type FormattedHit = SearchableProduct & { _formatted?: Partial<SearchableProduct> };

/**
 * The single place the search engine SDK is bound (ADR 0009). `SEARCH_ENABLED=false` leaves the
 * client unbuilt and every method a no-op, so dev and unit tests need no engine — the same gating
 * Sentry/OTel use when their config is absent. `search` swallows engine errors (an optional read
 * must never 5xx over Postgres data); the write methods let errors propagate so the caller owns the
 * best-effort decision.
 */
@Injectable()
export class MeilisearchCatalogSearch implements CatalogSearchPort {
  private readonly logger = new Logger(MeilisearchCatalogSearch.name);
  // Stateless HTTP client — nothing to open or close, so no shutdown hook (unlike the Redis client).
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
    await this.client.index(PRODUCTS_INDEX_UID).updateSettings(PRODUCTS_INDEX_SETTINGS).waitTask();
  }

  async resetIndex(): Promise<void> {
    const index = this.index();
    if (!index) return;
    await index.deleteAllDocuments().waitTask();
  }

  async bulkIndex(docs: SearchableProduct[]): Promise<void> {
    const index = this.index();
    if (!index || docs.length === 0) return;
    for (let offset = 0; offset < docs.length; offset += BULK_INDEX_CHUNK) {
      const chunk = docs.slice(offset, offset + BULK_INDEX_CHUNK);
      await index.addDocuments(chunk, { primaryKey: PRODUCTS_INDEX_PRIMARY_KEY }).waitTask();
    }
  }

  async indexProduct(doc: SearchableProduct): Promise<void> {
    const index = this.index();
    if (!index) return;
    await index.addDocuments([doc], { primaryKey: PRODUCTS_INDEX_PRIMARY_KEY }).waitTask();
  }

  async deleteProduct(id: string): Promise<void> {
    const index = this.index();
    if (!index) return;
    await index.deleteDocument(id).waitTask();
  }

  async search(criteria: SearchCriteria): Promise<SearchResult> {
    const index = this.index();
    if (!index) return { items: [], total: 0 };

    try {
      const response = await index.search(criteria.q, {
        limit: criteria.pageSize,
        offset: (criteria.page - 1) * criteria.pageSize,
        filter: criteria.categorySlug ? [`categorySlug = "${criteria.categorySlug}"`] : undefined,
        attributesToHighlight: ['name', 'description'],
        highlightPreTag: HIGHLIGHT_PRE_TAG,
        highlightPostTag: HIGHLIGHT_POST_TAG,
      });

      return {
        items: response.hits.map(toSearchHit),
        total: response.estimatedTotalHits ?? response.hits.length,
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
