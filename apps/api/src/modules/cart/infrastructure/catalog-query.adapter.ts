import { Inject, Injectable } from '@nestjs/common';
import {
  CATALOG_SKU_QUERY,
  type CatalogSkuQuery,
  type SkuView,
} from '@modules/catalog/application/public/catalog-sku-query.port';
import type { CartSkuView, CatalogQueryPort } from '../application/ports/catalog-query.port';

/**
 * The only place Cart touches Catalog, and it may import only Catalog's `application/public`
 * surface (allowed cross-context) — never its domain/infrastructure/schema.
 */
@Injectable()
export class CatalogQueryAdapter implements CatalogQueryPort {
  constructor(
    @Inject(CATALOG_SKU_QUERY)
    private readonly catalog: CatalogSkuQuery,
  ) {}

  async getSkuView(skuId: string): Promise<CartSkuView | null> {
    const view = await this.catalog.getSkuView(skuId);
    return view ? toCartSkuView(view) : null;
  }

  async getSkuViews(skuIds: string[]): Promise<CartSkuView[]> {
    const views = await this.catalog.getSkuViews(skuIds);
    return views.map(toCartSkuView);
  }
}

function toCartSkuView(view: SkuView): CartSkuView {
  return {
    skuId: view.skuId,
    productName: view.productName,
    unitPriceMinor: view.unitPriceMinor,
    currency: view.currency,
    isActive: view.isActive,
  };
}
