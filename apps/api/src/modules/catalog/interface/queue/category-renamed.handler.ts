import { Injectable } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { PinoLogger } from 'nestjs-pino';
import { PermanentError } from '@shared/messaging/errors';
import type { DomainEventJob } from '@shared/messaging/queue/domain-event.job';
import { ProductSearchSyncService } from '../../application/services/product-search-sync.service';

const LOG_CONTEXT = 'CategoryRenamedHandler';

@Injectable()
export class CategoryRenamedHandler {
  constructor(
    private readonly sync: ProductSearchSyncService,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(LOG_CONTEXT);
  }

  /** An engine failure throws through, so the delivery goes back on its retry ladder. */
  async apply(job: DomainEventJob): Promise<void> {
    if (!isUUID(job.aggregateId)) {
      throw new PermanentError(`catalog.category.renamed without a usable category id (message ${job.outboxId})`);
    }
    const products = await this.sync.syncCategory(job.aggregateId);
    this.logger.info({ categoryId: job.aggregateId, products }, 'category rename written to its products');
  }
}
