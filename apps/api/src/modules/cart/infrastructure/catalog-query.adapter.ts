import { Inject, Injectable } from '@nestjs/common';
import {
  PRODUCT_SKU_QUERY,
  type ProductSkuQuery,
  type SkuView,
} from '@modules/product/application/public/product-sku-query.port';
import type { CartSkuView, CatalogQueryPort } from '../application/ports/catalog-query.port';

/**
 * The only place Cart reads the catalog, and it may import only Product's `application/public`
 * surface (allowed cross-context) — never its domain/infrastructure/schema.
 */
@Injectable()
export class CatalogQueryAdapter implements CatalogQueryPort {
  constructor(
    @Inject(PRODUCT_SKU_QUERY)
    private readonly productSkuQuery: ProductSkuQuery,
  ) {}

  async getSkuView(skuId: string): Promise<CartSkuView | null> {
    const view = await this.productSkuQuery.getSkuView(skuId);
    return view ? toCartSkuView(view) : null;
  }

  async getSkuViews(skuIds: string[]): Promise<CartSkuView[]> {
    const views = await this.productSkuQuery.getSkuViews(skuIds);
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
