import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { toSearchDocumentWrite } from '../catalog-search.mapper';
import { CATALOG_SEARCH, PRODUCT_SEARCH_STATE, type CatalogSearchPort, type ProductSearchStatePort } from '../ports';

const LOG_CONTEXT = 'ProductSearchSyncService';

// Caps the product rows one page locks and the documents one engine write carries.
export const CATEGORY_FAN_OUT_BATCH = 500;

/**
 * Writes the product as it is now, never as the event saw it, so any delivery (late, repeated or out
 * of order) converges: the engine refuses a version at or below the one it holds.
 */
@Injectable()
export class ProductSearchSyncService {
  constructor(
    @Inject(PRODUCT_SEARCH_STATE) private readonly states: ProductSearchStatePort,
    @Inject(CATALOG_SEARCH) private readonly search: CatalogSearchPort,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(LOG_CONTEXT);
  }

  async syncProduct(productId: string): Promise<void> {
    const states = await this.states.findByIds([productId]);
    // Products are archived, never deleted: no row means a restored database or a forged message, and
    // a retry would find none either.
    if (states.length === 0) {
      this.logger.warn({ productId }, 'product change names no product; nothing indexed');
      return;
    }
    await this.search.write(states.map(toSearchDocumentWrite));
  }

  /**
   * Rewrites every product of the category, page by page, and returns how many it wrote. The category
   * lives only in the documents, so each page is bumped first. A failed page rejects, and the retry
   * starts over: bumping again only moves versions forward.
   */
  async syncCategory(categoryId: string, batchSize = CATEGORY_FAN_OUT_BATCH): Promise<number> {
    let written = 0;
    let afterId: string | null = null;
    for (;;) {
      const ids = await this.states.bumpCategoryProducts(categoryId, afterId, batchSize);
      if (ids.length === 0) return written;
      const states = await this.states.findByIds(ids);
      await this.search.write(states.map(toSearchDocumentWrite));
      written += states.length;
      afterId = ids[ids.length - 1];
    }
  }
}
