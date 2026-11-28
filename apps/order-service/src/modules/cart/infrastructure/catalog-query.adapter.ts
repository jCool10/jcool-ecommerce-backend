import { Inject, Injectable } from '@nestjs/common';
import {
  CATALOG_SKU_QUERY,
  type CatalogSkuQueryPort,
  type CatalogSkuView,
} from '../../catalog/application/public/catalog-sku-query.port';
import type { CartSkuView, CatalogQueryPort } from '../application/ports/catalog-query.port';

/** The only place Cart reads the catalog, through the read model's published surface. */
@Injectable()
export class CatalogQueryAdapter implements CatalogQueryPort {
  constructor(
    @Inject(CATALOG_SKU_QUERY)
    private readonly catalogSkuQuery: CatalogSkuQueryPort,
  ) {}

  async getSkuView(skuId: string): Promise<CartSkuView | null> {
    const view = await this.catalogSkuQuery.getSkuView(skuId);
    return view ? toCartSkuView(view) : null;
  }

  async getSkuViews(skuIds: string[]): Promise<CartSkuView[]> {
    const views = await this.catalogSkuQuery.getSkuViews(skuIds);
    return views.map(toCartSkuView);
  }
}

function toCartSkuView(view: CatalogSkuView): CartSkuView {
  return {
    skuId: view.skuId,
    productName: view.productName,
    unitPriceMinor: view.unitPriceMinor,
    currency: view.currency,
    isActive: view.isActive,
  };
}
