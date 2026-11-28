import { Inject, Injectable } from '@nestjs/common';
import { inArray, sql } from 'drizzle-orm';
import { isRoutableId } from '@jcool/id-codec';
import type { CatalogSkuSnapshotPayload } from '@jcool/internal-contracts/events/catalog-sku-snapshot';
import { DRIZZLE, type DrizzleDB, type DrizzleTx } from '../../../database';
import type { CatalogSkuQueryPort, CatalogSkuView } from '../application/public/catalog-sku-query.port';
import type { CatalogSkuViewWriterPort } from '../application/ports/catalog-sku-view-writer.port';
import { catalogSkuViews } from './schema/catalog-sku-view.schema';

const viewColumns = {
  skuId: catalogSkuViews.skuId,
  productName: catalogSkuViews.productName,
  unitPriceMinor: catalogSkuViews.unitPriceMinor,
  currency: catalogSkuViews.currency,
  isActive: catalogSkuViews.isActive,
};

@Injectable()
export class DrizzleCatalogSkuViewRepository implements CatalogSkuQueryPort, CatalogSkuViewWriterPort {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  async applySnapshot(
    tx: DrizzleTx,
    { productId, version, productName, skus }: CatalogSkuSnapshotPayload,
  ): Promise<void> {
    if (skus.length === 0) return;
    await tx
      .insert(catalogSkuViews)
      .values(
        skus.map(({ skuId, unitPriceMinor, currency, isActive }) => ({
          skuId,
          productId,
          productName,
          unitPriceMinor,
          currency,
          isActive,
          productVersion: version,
        })),
      )
      // Strictly lower: a redelivered or reordered snapshot at the same version changes nothing.
      .onConflictDoUpdate({
        target: catalogSkuViews.skuId,
        set: {
          productId: sql`excluded.product_id`,
          productName: sql`excluded.product_name`,
          unitPriceMinor: sql`excluded.unit_price_minor`,
          currency: sql`excluded.currency`,
          isActive: sql`excluded.is_active`,
          productVersion: sql`excluded.product_version`,
          updatedAt: sql`now()`,
        },
        setWhere: sql`${catalogSkuViews.productVersion} < excluded.product_version`,
      });
  }

  async getSkuView(skuId: string): Promise<CatalogSkuView | null> {
    const [view] = await this.getSkuViews([skuId]);
    return view ?? null;
  }

  // A non-routable id is never stored, and the bigint column would refuse it as a parameter.
  async getSkuViews(skuIds: readonly string[]): Promise<CatalogSkuView[]> {
    const ids = skuIds.filter(isRoutableId);
    if (ids.length === 0) return [];
    return this.db.select(viewColumns).from(catalogSkuViews).where(inArray(catalogSkuViews.skuId, ids));
  }
}
