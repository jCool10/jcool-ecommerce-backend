import { Inject, Injectable } from '@nestjs/common';
import { PRODUCT_REPOSITORY, type ProductRepositoryPort } from '../ports';
import type { CatalogSkuQuery, SkuView } from '../public/catalog-sku-query.port';

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
