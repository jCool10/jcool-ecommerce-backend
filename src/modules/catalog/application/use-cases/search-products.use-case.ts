import { Inject, Injectable } from '@nestjs/common';
import { CATALOG_SEARCH, type CatalogSearchPort, type SearchCriteria, type SearchHit } from '../ports';

export interface SearchProductsResult {
  items: SearchHit[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

// Relevance search over the derived index — a parallel read path to `ListProductsUseCase`, which
// stays on Postgres. Owns the pagination math; the port owns matching and ranking.
@Injectable()
export class SearchProductsUseCase {
  constructor(
    @Inject(CATALOG_SEARCH)
    private readonly search: CatalogSearchPort,
  ) {}

  async execute(criteria: SearchCriteria): Promise<SearchProductsResult> {
    const { items, total } = await this.search.search(criteria);
    // An engine that is down answers with an empty result rather than throwing, so this path also
    // covers the degraded case: zero hits, zero pages, no error for the caller to handle.
    const totalPages = criteria.pageSize > 0 ? Math.ceil(total / criteria.pageSize) : 0;
    return {
      items,
      total,
      page: criteria.page,
      pageSize: criteria.pageSize,
      totalPages,
    };
  }
}
