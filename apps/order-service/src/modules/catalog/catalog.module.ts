import { Module } from '@nestjs/common';
import { CATALOG_SKU_VIEW_WRITER } from './application/ports/catalog-sku-view-writer.port';
import { CATALOG_SKU_QUERY } from './application/public/catalog-sku-query.port';
import { DrizzleCatalogSkuViewRepository } from './infrastructure/drizzle-catalog-sku-view.repository';
import { CatalogSkuSnapshotHandler } from './interface/queue/catalog-sku-snapshot.handler';

/** A read model of the api's catalog, fed by its SKU snapshots on order-events. */
@Module({
  providers: [
    DrizzleCatalogSkuViewRepository,
    { provide: CATALOG_SKU_QUERY, useExisting: DrizzleCatalogSkuViewRepository },
    { provide: CATALOG_SKU_VIEW_WRITER, useExisting: DrizzleCatalogSkuViewRepository },
    CatalogSkuSnapshotHandler,
  ],
  exports: [CATALOG_SKU_QUERY, CatalogSkuSnapshotHandler],
})
export class CatalogModule {}
