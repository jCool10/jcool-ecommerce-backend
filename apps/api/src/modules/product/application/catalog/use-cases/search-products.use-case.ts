import { Inject, Injectable } from '@nestjs/common';
import { CATALOG_SEARCH, type CatalogSearchPort, type SearchCriteria, type SearchHit } from '../ports';

export interface SearchProductsResult {
  items: SearchHit[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

// A parallel read path to `ListProductsUseCase`, which stays on Postgres.
@Injectable()
export class SearchProductsUseCase {
  constructor(
    @Inject(CATALOG_SEARCH)
    private readonly search: CatalogSearchPort,
  ) {}

  async execute(criteria: SearchCriteria): Promise<SearchProductsResult> {
    const { items, total } = await this.search.search(criteria);
    // A downed engine answers with an empty result rather than throwing, so the degraded case needs
    // no handling here: zero hits, zero pages.
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
