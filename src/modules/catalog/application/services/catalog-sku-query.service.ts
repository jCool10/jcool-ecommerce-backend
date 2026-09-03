import { Inject, Injectable } from '@nestjs/common';
import { PRODUCT_REPOSITORY, type ProductRepositoryPort } from '../ports';
import type { CatalogSkuQuery, SkuView } from '../public/catalog-sku-query.port';

/**
 * Implements Catalog's published SKU-read port over the existing read
 * repository. Thin by design: the port is a stable cross-context contract, the
 * repository is the swap point (cache/search later). No business rules here.
 */
@Injectable()
export class CatalogSkuQueryService implements CatalogSkuQuery {
  constructor(
    @Inject(PRODUCT_REPOSITORY)
    private readonly products: ProductRepositoryPort,
  ) {}

  getSkuView(skuId: string): Promise<SkuView | null> {
    return this.products.findSkuView(skuId);
  }

  getSkuViews(skuIds: string[]): Promise<SkuView[]> {
    return this.products.findManySkuViews(skuIds);
  }
}
