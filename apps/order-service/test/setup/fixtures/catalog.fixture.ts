import type { INestApplication } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import {
  CATALOG_SNAPSHOT_CURRENCY,
  type CatalogSkuSnapshotPayload,
  catalogSkuSnapshotPayload,
} from '@jcool/internal-contracts/events/catalog-sku-snapshot';
import { DRIZZLE, type DrizzleDB } from '../../../src/database';
import * as schema from '../../../src/database/schema';
import {
  CATALOG_SKU_VIEW_WRITER,
  type CatalogSkuViewWriterPort,
} from '../../../src/modules/catalog/application/ports/catalog-sku-view-writer.port';
import { testId } from '../id-service-stub';

// The catalog is the api's; this service holds the read model its snapshots feed. Every arrangement
// goes through the production contract builder and writer, so no fixture can hold a row the
// consumer's guard would refuse.

export interface TestProductOptions {
  /** Anything but ACTIVE reads inactive. */
  status?: 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
  /** Integer minor units; null leaves the SKU unpriced. */
  priceMinor?: number | null;
  name?: string;
}

export interface TestProduct {
  productId: string;
  name: string;
  variantId: string;
  priceMinor: number | null;
}

export async function createTestProduct(app: INestApplication, options: TestProductOptions = {}): Promise<TestProduct> {
  const productId = testId();
  const variantId = testId();
  const name = options.name ?? `Product ${variantId}`;
  const priceMinor = options.priceMinor === undefined ? 199_000 : options.priceMinor;
  await publishSnapshot(app, {
    productId,
    version: 1,
    productName: name,
    skus: [
      {
        skuId: variantId,
        unitPriceMinor: priceMinor,
        currency: CATALOG_SNAPSHOT_CURRENCY,
        isActive: (options.status ?? 'ACTIVE') === 'ACTIVE',
      },
    ],
  });
  return { productId, name, variantId, priceMinor };
}

/** The price stays: the api publishes an archived product inactive, not unpriced. */
export async function archiveProduct(app: INestApplication, productId: string): Promise<void> {
  const current = await snapshotOf(app, productId);
  await publishSnapshot(app, {
    ...current,
    version: current.version + 1,
    skus: current.skus.map((sku) => ({ ...sku, isActive: false })),
  });
}

export async function repriceSku(app: INestApplication, variantId: string, amountMinor: number | null): Promise<void> {
  const current = await snapshotOf(app, await productOf(app, variantId));
  await publishSnapshot(app, {
    ...current,
    version: current.version + 1,
    skus: current.skus.map((sku) => (sku.skuId === variantId ? { ...sku, unitPriceMinor: amountMinor } : sku)),
  });
}

/** No snapshot deletes a row; this stands for a read model truncated and not yet synced again. */
export async function dropSkuView(app: INestApplication, variantId: string): Promise<void> {
  await db(app).delete(schema.catalogSkuViews).where(eq(schema.catalogSkuViews.skuId, variantId));
}

async function publishSnapshot(app: INestApplication, facts: CatalogSkuSnapshotPayload): Promise<void> {
  const payload = catalogSkuSnapshotPayload(facts);
  const writer = app.get<CatalogSkuViewWriterPort>(CATALOG_SKU_VIEW_WRITER);
  await db(app).transaction((tx) => writer.applySnapshot(tx, payload));
}

async function snapshotOf(app: INestApplication, productId: string): Promise<CatalogSkuSnapshotPayload> {
  const rows = await db(app)
    .select()
    .from(schema.catalogSkuViews)
    .where(eq(schema.catalogSkuViews.productId, productId))
    .orderBy(asc(schema.catalogSkuViews.skuId));
  if (rows.length === 0) throw new Error(`the read model holds no SKU of product ${productId}`);
  return {
    productId,
    version: rows[0].productVersion,
    productName: rows[0].productName,
    skus: rows.map(({ skuId, unitPriceMinor, currency, isActive }) => ({ skuId, unitPriceMinor, currency, isActive })),
  };
}

async function productOf(app: INestApplication, variantId: string): Promise<string> {
  const [row] = await db(app)
    .select({ productId: schema.catalogSkuViews.productId })
    .from(schema.catalogSkuViews)
    .where(eq(schema.catalogSkuViews.skuId, variantId));
  if (!row) throw new Error(`the read model holds no SKU ${variantId}`);
  return row.productId;
}

const db = (app: INestApplication): DrizzleDB => app.get<DrizzleDB>(DRIZZLE);
