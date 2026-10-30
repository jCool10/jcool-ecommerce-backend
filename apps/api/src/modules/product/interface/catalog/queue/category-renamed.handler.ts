import { Injectable } from '@nestjs/common';
import { isRoutableId } from '@jcool/id-codec';
import { PinoLogger } from 'nestjs-pino';
import { type DomainEventJob, PermanentError } from '@jcool/messaging';
import { ProductSearchSyncService } from '../../../application/catalog/services/product-search-sync.service';

const LOG_CONTEXT = 'CategoryRenamedHandler';

@Injectable()
export class CategoryRenamedHandler {
  constructor(
    private readonly productSearchSyncService: ProductSearchSyncService,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(LOG_CONTEXT);
  }

  /** An engine failure throws through, so the delivery goes back on its retry ladder. */
  async apply(job: DomainEventJob): Promise<void> {
    if (!isRoutableId(job.aggregateId)) {
      throw new PermanentError(`catalog.category.renamed without a usable category id (message ${job.outboxId})`);
    }
    const products = await this.productSearchSyncService.syncCategory(job.aggregateId);
    this.logger.info({ categoryId: job.aggregateId, products }, 'category rename written to its products');
  }
}
