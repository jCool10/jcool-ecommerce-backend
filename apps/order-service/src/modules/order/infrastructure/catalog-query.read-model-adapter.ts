import { Inject, Injectable } from '@nestjs/common';
import { CATALOG_SKU_QUERY, type CatalogSkuQueryPort } from '../../catalog/application/public/catalog-sku-query.port';
import type { CatalogQueryPort, OrderSkuView } from '../application/ports/catalog-query.port';

@Injectable()
export class CatalogQueryReadModelAdapter implements CatalogQueryPort {
  constructor(@Inject(CATALOG_SKU_QUERY) private readonly catalog: CatalogSkuQueryPort) {}

  async getSkuViews(skuIds: string[]): Promise<OrderSkuView[]> {
    const ids = [...new Set(skuIds)];
    if (ids.length === 0) return [];
    const views = await this.catalog.getSkuViews(ids);
    return views.map(({ skuId, productName, unitPriceMinor, currency, isActive }) => ({
      skuId,
      productName,
      unitPriceMinor,
      currency,
      isActive,
    }));
  }
}
