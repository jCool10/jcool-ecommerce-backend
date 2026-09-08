import { Inject, Injectable } from '@nestjs/common';
import {
  CATALOG_SKU_QUERY,
  type CatalogSkuQuery,
  type SkuView,
} from '@modules/catalog/application/public/catalog-sku-query.port';
import type { CatalogQueryPort, OrderSkuView } from '../application/ports/catalog-query.port';

// The only place Order touches Catalog, and only through Catalog's `application/public` surface.
@Injectable()
export class CatalogQueryAdapter implements CatalogQueryPort {
  constructor(
    @Inject(CATALOG_SKU_QUERY)
    private readonly catalog: CatalogSkuQuery,
  ) {}

  async getSkuViews(skuIds: string[]): Promise<OrderSkuView[]> {
    const views = await this.catalog.getSkuViews(skuIds);
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
