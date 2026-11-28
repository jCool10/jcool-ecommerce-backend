import { Inject, Injectable } from '@nestjs/common';
import { isRoutableId } from '@jcool/id-codec';
import {
  CATALOG_SKU_SNAPSHOT_EVENT,
  type CatalogSkuSnapshotPayload,
  catalogSkuSnapshotDefect,
} from '@jcool/internal-contracts/events/catalog-sku-snapshot';
import { type DomainEventJob, PermanentError } from '@jcool/messaging';
import type { DrizzleTx } from '../../../../database';
import {
  CATALOG_SKU_VIEW_WRITER,
  type CatalogSkuViewWriterPort,
} from '../../application/ports/catalog-sku-view-writer.port';

/** The bus is not authenticated per message, so the contract's bounds are this consumer's boundary. */
function defectOf(job: DomainEventJob): string | undefined {
  const defect = catalogSkuSnapshotDefect(job.payload);
  if (defect) return defect;
  const { productId, skus } = job.payload as unknown as CatalogSkuSnapshotPayload;
  if (!isRoutableId(productId)) return 'productId is not a routable id';
  const unroutable = skus.findIndex(({ skuId }) => !isRoutableId(skuId));
  if (unroutable !== -1) return `skus[${unroutable}].skuId is not a routable id`;
  if (job.aggregateId !== productId) return 'aggregateId is not the payload productId';
  return undefined;
}

@Injectable()
export class CatalogSkuSnapshotHandler {
  constructor(@Inject(CATALOG_SKU_VIEW_WRITER) private readonly writer: CatalogSkuViewWriterPort) {}

  /** Checked before the transaction: a refused snapshot is identical on every redelivery. */
  prepare(job: DomainEventJob): Promise<(tx: DrizzleTx) => Promise<void>> {
    const defect = defectOf(job);
    if (defect) {
      return Promise.reject(
        new PermanentError(`Unusable ${CATALOG_SKU_SNAPSHOT_EVENT} event ${job.outboxId}: ${defect}`),
      );
    }
    const snapshot = job.payload as unknown as CatalogSkuSnapshotPayload;
    return Promise.resolve((tx) => this.writer.applySnapshot(tx, snapshot));
  }
}
