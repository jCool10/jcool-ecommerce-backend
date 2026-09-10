import { Inject, Injectable } from '@nestjs/common';
import type { Product } from '../../domain/entities';
import {
  type FindManyActiveCriteria,
  MEDIA_QUERY,
  PRODUCT_REPOSITORY,
  type MediaQueryPort,
  type ProductRepositoryPort,
} from '../ports';

export interface ListProductsResult {
  items: Product[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  /** assetId → URL for the whole page, resolved in one call rather than one per product. */
  imageUrls: Map<string, string>;
}

@Injectable()
export class ListProductsUseCase {
  constructor(
    @Inject(PRODUCT_REPOSITORY)
    private readonly products: ProductRepositoryPort,
    @Inject(MEDIA_QUERY)
    private readonly media: MediaQueryPort,
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
      imageUrls: await this.media.resolveUrls(items.flatMap((product) => product.imageAssetIds)),
    };
  }
}
