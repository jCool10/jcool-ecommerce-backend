import { Inject, Injectable } from '@nestjs/common';
import type { Product } from '../../domain/entities';
import { type FindManyActiveCriteria, PRODUCT_REPOSITORY, type ProductRepositoryPort } from '../ports';

export interface ListProductsResult {
  items: Product[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

// List ACTIVE products (paginated + filtered). Owns the pagination math; the
// repository owns data access behind the port.
@Injectable()
export class ListProductsUseCase {
  constructor(
    @Inject(PRODUCT_REPOSITORY)
    private readonly products: ProductRepositoryPort,
  ) {}

  async execute(criteria: FindManyActiveCriteria): Promise<ListProductsResult> {
    const { items, total } = await this.products.findManyActive(criteria);
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
