import type { CatalogSkuSnapshotPayload } from '@jcool/internal-contracts/events/catalog-sku-snapshot';
import type { DrizzleTx } from '../../../../database';

export const CATALOG_SKU_VIEW_WRITER = Symbol('CATALOG_SKU_VIEW_WRITER');

export interface CatalogSkuViewWriterPort {
  /** Runs in the consumer's transaction, so the inbox claim and the rows commit together. */
  applySnapshot(tx: DrizzleTx, snapshot: CatalogSkuSnapshotPayload): Promise<void>;
}
