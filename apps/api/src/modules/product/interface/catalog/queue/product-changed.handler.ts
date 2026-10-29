import { Injectable } from '@nestjs/common';
import { isRoutableId } from '@jcool/id-codec';
import { type DomainEventJob, PermanentError } from '@jcool/messaging';
import { ProductSearchSyncService } from '../../../application/catalog/services/product-search-sync.service';

@Injectable()
export class ProductChangedHandler {
  constructor(private readonly productSearchSyncService: ProductSearchSyncService) {}

  /** An engine failure throws through, so the delivery goes back on its retry ladder. */
  async apply(job: DomainEventJob): Promise<void> {
    if (!isRoutableId(job.aggregateId)) {
      throw new PermanentError(`catalog.product.changed without a usable product id (message ${job.outboxId})`);
    }
    await this.productSearchSyncService.syncProduct(job.aggregateId);
  }
}
