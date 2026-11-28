import { Inject, Injectable } from '@nestjs/common';
import { asc, eq, gt } from 'drizzle-orm';
import { OUTBOX_WRITER, type OutboxWriterPort } from '@jcool/messaging/outbox-port';
import { DRIZZLE, type DrizzleDB, type DrizzleTx } from '@shared/infrastructure/database';
import { toSkuSnapshotRecord } from '../../../application/catalog/catalog-outbox.mapper';
import { productVariants, products } from '../schema/catalog.schema';
import { selectSkuViews } from '../sku-view.query';
import type { SkuSnapshotPages } from './publish-sku-snapshots-runner';

@Injectable()
export class SkuSnapshotPublisher implements SkuSnapshotPages {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    @Inject(OUTBOX_WRITER) private readonly outboxWriter: OutboxWriterPort,
  ) {}

  /**
   * Must be the last statement of a catalog write: it reads the product as the transaction leaves it,
   * at the version the write bumped under the product row lock, so commit order is version order.
   */
  async append(tx: DrizzleTx, productId: string, options: { id?: string } = {}): Promise<void> {
    const [product] = await tx
      .select({ version: products.searchVersion, name: products.name })
      .from(products)
      .where(eq(products.id, productId));
    if (!product) throw new Error(`no product ${productId} to snapshot`);

    const skus = await selectSkuViews(tx, eq(productVariants.productId, productId));
    await this.outboxWriter.append(
      tx,
      toSkuSnapshotRecord({ productId, version: product.version, productName: product.name, skus }),
      options,
    );
  }

  async productIdsAfter(afterId: string | null, limit: number): Promise<string[]> {
    const rows = await this.db
      .select({ id: products.id })
      .from(products)
      .where(afterId ? gt(products.id, afterId) : undefined)
      .orderBy(asc(products.id))
      .limit(limit);
    return rows.map((row) => row.id);
  }

  // Repeatable read, so a write committing mid-page cannot pair one version with another's SKUs.
  appendPage(productIds: readonly string[], outboxIds: readonly string[]): Promise<void> {
    return this.db.transaction(
      async (tx) => {
        for (const [index, productId] of productIds.entries()) {
          await this.append(tx, productId, { id: outboxIds[index] });
        }
      },
      { isolationLevel: 'repeatable read' },
    );
  }
}
