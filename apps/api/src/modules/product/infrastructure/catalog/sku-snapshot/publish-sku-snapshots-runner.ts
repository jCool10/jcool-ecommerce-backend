import type { IdGeneratorPort } from '@shared/identity/id-generator.port';

const PAGE_SIZE = 100;

export interface SkuSnapshotPages {
  /** At most `limit` product ids after `afterId`, ascending. */
  productIdsAfter(afterId: string | null, limit: number): Promise<string[]>;
  /** One snapshot per product, all in one transaction, each under the outbox id at its index. */
  appendPage(productIds: readonly string[], outboxIds: readonly string[]): Promise<void>;
}

export interface PublishSkuSnapshotsOptions {
  pageSize?: number;
  /** Checked between pages. A page already appended stays, which is harmless: so is a re-run. */
  signal?: AbortSignal;
}

/**
 * Appends a current snapshot of every product. Safe to run at any time, live writes included: the
 * consumer keeps the highest version per product, and a write that lands mid-run publishes its own.
 */
export async function publishSkuSnapshots(
  pages: SkuSnapshotPages,
  ids: Pick<IdGeneratorPort, 'mint'>,
  { pageSize = PAGE_SIZE, signal }: PublishSkuSnapshotsOptions = {},
): Promise<number> {
  if (!Number.isInteger(pageSize) || pageSize < 1)
    throw new RangeError(`page size must be at least 1, got ${pageSize}`);

  let published = 0;
  let afterId: string | null = null;
  for (;;) {
    signal?.throwIfAborted();
    const productIds = await pages.productIdsAfter(afterId, pageSize);
    if (productIds.length === 0) break;

    // Minted before the page's transaction opens, so no transaction waits on the id service.
    const outboxIds = await ids.mint(productIds.length);
    if (outboxIds.length !== productIds.length) {
      throw new Error(`asked the id service for ${productIds.length} ids, got ${outboxIds.length}`);
    }
    await pages.appendPage(productIds, outboxIds);

    published += productIds.length;
    afterId = productIds[productIds.length - 1];
    if (productIds.length < pageSize) break;
  }
  return published;
}
