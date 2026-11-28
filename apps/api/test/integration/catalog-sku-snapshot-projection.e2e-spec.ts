import type { INestApplication } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  CATALOG_SKU_SNAPSHOT_EVENT,
  type CatalogSkuSnapshotPayload,
  isCatalogSkuSnapshotPayload,
} from '@jcool/internal-contracts/events/catalog-sku-snapshot';
import { publishSkuSnapshots } from '../../src/modules/product/infrastructure/catalog/sku-snapshot/publish-sku-snapshots-runner';
import { SkuSnapshotPublisher } from '../../src/modules/product/infrastructure/catalog/sku-snapshot/sku-snapshot.publisher';
import { ID_GENERATOR, type IdGeneratorPort } from '../../src/shared/identity/id-generator.port';
import type { DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import { createTestProduct, type TestProduct } from '../setup/fixtures/catalog.fixture';
import { closeAppAfterAll, createTestAppWithPool, resetDatabaseBeforeEach } from '../setup/harness';
import { testId } from '../setup/id-service-stub';

type SnapshotSku = CatalogSkuSnapshotPayload['skus'][number];

interface SkuSeed {
  /** Null leaves the SKU without a price. */
  priceMinor?: number | null;
  currency?: string;
  archived?: boolean;
}

let seq = 0;

const view = (skuId: string, unitPriceMinor: number | null, isActive = true): SnapshotSku => ({
  skuId,
  unitPriceMinor,
  currency: 'VND',
  isActive,
});

const inSkuOrder = (skus: SnapshotSku[]): SnapshotSku[] =>
  [...skus].sort((a, b) => (BigInt(a.skuId) < BigInt(b.skuId) ? -1 : 1));

// The snapshot is the order-service's only source of catalog facts, so what each SKU state reads as
// is pinned here, on the payload a publish leaves in the outbox.
describe('Catalog SKU snapshot projection (integration, real Postgres)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;

  beforeAll(async () => {
    ({ app, pool, db } = await createTestAppWithPool());
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  async function addSku(product: TestProduct, seed: SkuSeed = {}): Promise<string> {
    const [variant] = await db
      .insert(schema.productVariants)
      .values({
        id: testId(),
        sku: `PROJECTION-${Date.now()}-${seq++}`,
        name: 'Another size',
        productId: product.productId,
        archivedAt: seed.archived ? new Date() : null,
      })
      .returning();
    if (seed.priceMinor !== null) {
      await db.insert(schema.prices).values({
        id: testId(),
        variantId: variant.id,
        currency: seed.currency ?? 'VND',
        amountMinor: seed.priceMinor ?? 10_000,
      });
    }
    return variant.id;
  }

  async function addPrice(variantId: string, currency: string, amountMinor: number): Promise<void> {
    await db.insert(schema.prices).values({ id: testId(), variantId, currency, amountMinor });
  }

  async function unprice(variantId: string): Promise<void> {
    await db.delete(schema.prices).where(eq(schema.prices.variantId, variantId));
  }

  const publishCatalog = () =>
    publishSkuSnapshots(app.get(SkuSnapshotPublisher), app.get<IdGeneratorPort>(ID_GENERATOR), { pageSize: 100 });

  async function expectPublished(product: TestProduct, skus: SnapshotSku[]): Promise<void> {
    const rows = await db
      .select({ payload: schema.outbox.payload })
      .from(schema.outbox)
      .where(
        and(eq(schema.outbox.aggregateId, product.productId), eq(schema.outbox.eventType, CATALOG_SKU_SNAPSHOT_EVENT)),
      );
    expect(rows).toHaveLength(1);
    const [{ payload }] = rows;
    if (!isCatalogSkuSnapshotPayload(payload)) throw new Error(`snapshot of ${product.productId} fails its guard`);

    expect({ ...payload, skus: inSkuOrder(payload.skus) }).toEqual({
      productId: product.productId,
      version: 0,
      productName: product.name,
      skus: inSkuOrder(skus),
    });
  }

  it('lists only the SKUs the product still has, none of another product', async () => {
    const product = await createTestProduct(app, { priceMinor: 100_000 });
    const other = await createTestProduct(app, { priceMinor: 20_000 });
    const removed = await addSku(product);
    await unprice(removed);
    await db.delete(schema.productVariants).where(eq(schema.productVariants.id, removed));

    await publishCatalog();

    await expectPublished(product, [view(product.variantId, 100_000)]);
    await expectPublished(other, [view(other.variantId, 20_000)]);
  });

  it.each([
    ['an archived product', 'ARCHIVED'],
    ['a draft product', 'DRAFT'],
  ] as const)('reads every SKU of %s inactive, keeping its price', async (_case, status) => {
    const product = await createTestProduct(app, { status, priceMinor: 50_000 });

    await publishCatalog();

    await expectPublished(product, [view(product.variantId, 50_000, false)]);
  });

  it('reads an archived SKU inactive, keeping its price', async () => {
    const product = await createTestProduct(app, { priceMinor: 100_000 });
    const retired = await addSku(product, { priceMinor: 50_000, archived: true });

    await publishCatalog();

    await expectPublished(product, [view(product.variantId, 100_000), view(retired, 50_000, false)]);
  });

  it('reads an unpriced SKU with a null price, still active', async () => {
    const product = await createTestProduct(app);
    await unprice(product.variantId);

    await publishCatalog();

    await expectPublished(product, [view(product.variantId, null)]);
  });

  it('reads the VND price only, so a SKU priced in another currency alone is unpriced', async () => {
    const product = await createTestProduct(app, { priceMinor: 990, currency: 'USD' });
    const both = await addSku(product, { priceMinor: 120_000 });
    await addPrice(both, 'USD', 5);

    await publishCatalog();

    await expectPublished(product, [view(product.variantId, null), view(both, 120_000)]);
  });

  it.each([0, -1])('publishes a stored price of %i as unpriced', async (amountMinor) => {
    const product = await createTestProduct(app);
    await db.update(schema.prices).set({ amountMinor }).where(eq(schema.prices.variantId, product.variantId));

    await publishCatalog();

    await expectPublished(product, [view(product.variantId, null)]);
  });

  it('keys every view to its own SKU in a product mixing every state', async () => {
    const product = await createTestProduct(app, { priceMinor: 100_000 });
    const unpriced = await addSku(product, { priceMinor: null });
    const retired = await addSku(product, { priceMinor: 7_000, archived: true });
    const foreign = await addSku(product, { priceMinor: 990, currency: 'USD' });
    const repriced = await addSku(product, { priceMinor: 33_000 });

    await publishCatalog();

    await expectPublished(product, [
      view(product.variantId, 100_000),
      view(unpriced, null),
      view(retired, 7_000, false),
      view(foreign, null),
      view(repriced, 33_000),
    ]);
  });
});
