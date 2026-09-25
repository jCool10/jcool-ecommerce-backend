import { Injectable } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { PermanentError } from '@shared/messaging/errors';
import type { DomainEventJob } from '@shared/messaging/queue/domain-event.job';
import { ProductSearchSyncService } from '../../application/services/product-search-sync.service';

@Injectable()
export class ProductChangedHandler {
  constructor(private readonly sync: ProductSearchSyncService) {}

  /** An engine failure throws through, so the delivery goes back on its retry ladder. */
  async apply(job: DomainEventJob): Promise<void> {
    if (!isUUID(job.aggregateId)) {
      throw new PermanentError(`catalog.product.changed without a usable product id (message ${job.outboxId})`);
    }
    await this.sync.syncProduct(job.aggregateId);
  }
}
