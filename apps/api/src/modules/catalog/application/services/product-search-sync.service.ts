import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { toSearchDocumentWrite } from '../catalog-search.mapper';
import { CATALOG_SEARCH, PRODUCT_SEARCH_STATE, type CatalogSearchPort, type ProductSearchStatePort } from '../ports';

const LOG_CONTEXT = 'ProductSearchSyncService';

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
}
