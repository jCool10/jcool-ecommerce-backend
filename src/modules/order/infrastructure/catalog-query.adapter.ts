import { Inject, Injectable } from '@nestjs/common';
import {
  CATALOG_SKU_QUERY,
  type CatalogSkuQuery,
  type SkuView,
} from '@modules/catalog/application/public/catalog-sku-query.port';
import type { CatalogQueryPort, OrderSkuView } from '../application/ports/catalog-query.port';

/**
 * Anti-corruption adapter: implements Order's `CatalogQueryPort` by delegating to
 * Catalog's published `CATALOG_SKU_QUERY`. Used at order-creation time to resolve
 * live price/name, which Order then freezes into the order. Imports only Catalog's
 * `application/public` surface (allowed cross-context) — never its internals.
 */
@Injectable()
export class CatalogQueryAdapter implements CatalogQueryPort {
  constructor(
    @Inject(CATALOG_SKU_QUERY)
    private readonly catalog: CatalogSkuQuery,
  ) {}

  async getSkuView(skuId: string): Promise<OrderSkuView | null> {
    const view = await this.catalog.getSkuView(skuId);
    return view ? toOrderSkuView(view) : null;
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
