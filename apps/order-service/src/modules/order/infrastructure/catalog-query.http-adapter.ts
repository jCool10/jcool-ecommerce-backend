import { MAX_SKU_VIEW_BATCH, apiReadRoutes, skuViewsOf } from '@jcool/internal-contracts';
import type { CatalogQueryPort, OrderSkuView } from '../application/ports/catalog-query.port';
import type { ApiInternalClient } from './api-internal.http-client';

/** A cart has no line limit but the route takes 100 ids, so a big cart reads in batches, one at a time. */
export class CatalogQueryHttpAdapter implements CatalogQueryPort {
  constructor(private readonly api: ApiInternalClient) {}

  async getSkuViews(skuIds: string[]): Promise<OrderSkuView[]> {
    const ids = [...new Set(skuIds)];
    const views = new Map<string, OrderSkuView>();
    for (let start = 0; start < ids.length; start += MAX_SKU_VIEW_BATCH) {
      const batch = ids.slice(start, start + MAX_SKU_VIEW_BATCH);
      for (const view of await this.api.read(apiReadRoutes.skuViews, { skuIds: batch }, skuViewsOf)) {
        views.set(view.skuId, view);
      }
    }
    return [...views.values()];
  }
}
