import { Injectable } from '@nestjs/common';
import { isRoutableId } from '@jcool/id-codec';
import { PermanentError } from '@shared/messaging/errors';
import type { DomainEventJob } from '@shared/messaging/queue/domain-event.job';
import { ProductSearchSyncService } from '../../application/services/product-search-sync.service';

@Injectable()
export class ProductChangedHandler {
  constructor(private readonly sync: ProductSearchSyncService) {}

  /** An engine failure throws through, so the delivery goes back on its retry ladder. */
  async apply(job: DomainEventJob): Promise<void> {
    if (!isRoutableId(job.aggregateId)) {
      throw new PermanentError(`catalog.product.changed without a usable product id (message ${job.outboxId})`);
    }
    await this.sync.syncProduct(job.aggregateId);
  }
}
