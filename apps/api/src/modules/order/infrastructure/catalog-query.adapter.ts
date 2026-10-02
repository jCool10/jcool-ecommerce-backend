import { Inject, Injectable } from '@nestjs/common';
import {
  PRODUCT_SKU_QUERY,
  type ProductSkuQuery,
  type SkuView,
} from '@modules/product/application/public/product-sku-query.port';
import type { CatalogQueryPort, OrderSkuView } from '../application/ports/catalog-query.port';

// The only place Order reads the catalog, and only through Product's `application/public` surface.
@Injectable()
export class CatalogQueryAdapter implements CatalogQueryPort {
  constructor(
    @Inject(PRODUCT_SKU_QUERY)
    private readonly productSkuQuery: ProductSkuQuery,
  ) {}

  async getSkuViews(skuIds: string[]): Promise<OrderSkuView[]> {
    const views = await this.productSkuQuery.getSkuViews(skuIds);
    return views.map(toOrderSkuView);
  }
}

function toOrderSkuView(view: SkuView): OrderSkuView {
  return {
    skuId: view.skuId,
    productName: view.productName,
    unitPriceMinor: view.unitPriceMinor,
    currency: view.currency,
    isActive: view.isActive,
  };
}
