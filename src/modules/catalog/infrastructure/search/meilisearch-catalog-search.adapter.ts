import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Meilisearch, type Index } from 'meilisearch';
import type {
  CatalogSearchPort,
  SearchCriteria,
  SearchHit,
  SearchResult,
  SearchableProduct,
} from '../../application/ports';

const INDEX_UID = 'products';
const HIGHLIGHT_PRE_TAG = '<em>';
const HIGHLIGHT_POST_TAG = '</em>';

// Baseline index settings. Ranking rules are left at the engine defaults
// (words → typo → proximity → attribute → sort → exactness), which give typo-tolerant relevance
// with no configuration — the reason for choosing a search engine over `ilike`.
const SEARCHABLE_ATTRIBUTES = ['name', 'description', 'skus', 'categoryName'];
const FILTERABLE_ATTRIBUTES = ['categorySlug', 'status'];
const SORTABLE_ATTRIBUTES = ['createdAtEpoch', 'minPriceMinor'];

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

  constructor(config: ConfigService) {
    const enabled = config.get<boolean>('search.enabled') ?? false;
    this.client = enabled
      ? new Meilisearch({
          host: config.getOrThrow<string>('search.url'),
          apiKey: config.get<string>('search.apiKey'),
        })
      : null;
  }

  private index(): Index<SearchableProduct> | null {
    return this.client?.index<SearchableProduct>(INDEX_UID) ?? null;
  }

  async ensureIndex(): Promise<void> {
    if (!this.client) return;
    // createIndex enqueues a task that fails harmlessly when the index already exists; tolerate that
    // and always (re)apply settings, which is itself idempotent — a real down-engine error still
    // surfaces from updateSettings below.
    await this.client
      .createIndex(INDEX_UID, { primaryKey: 'id' })
      .waitTask()
      .catch(() => undefined);
    await this.client
      .index(INDEX_UID)
      .updateSettings({
        searchableAttributes: SEARCHABLE_ATTRIBUTES,
        filterableAttributes: FILTERABLE_ATTRIBUTES,
        sortableAttributes: SORTABLE_ATTRIBUTES,
      })
      .waitTask();
  }

  async bulkIndex(docs: SearchableProduct[]): Promise<void> {
    const index = this.index();
    if (!index || docs.length === 0) return;
    await index.addDocuments(docs, { primaryKey: 'id' }).waitTask();
  }

  async indexProduct(doc: SearchableProduct): Promise<void> {
    const index = this.index();
    if (!index) return;
    await index.addDocuments([doc], { primaryKey: 'id' }).waitTask();
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
