import type { INestApplication } from '@nestjs/common';
import { DRIZZLE, type DrizzleDB } from '../../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../../src/shared/infrastructure/database/schema';

// Direct inserts (mirroring seed.ts) so a fixture doesn't depend on the write API.
let seq = 0;
const uniq = (): string => `${Date.now()}-${seq++}`;

export interface TestCategory {
  id: string;
  slug: string;
}

export interface TestProductOptions {
  categoryId?: string;
  status?: 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
  priceMinor?: number; // integer smallest units (VND đồng)
  currency?: string;
}

export interface TestProduct {
  categoryId: string;
  productId: string;
  variantId: string;
  sku: string;
  priceId: string;
  priceMinor: number;
}

export async function createTestCategory(app: INestApplication, name = 'Test Category'): Promise<TestCategory> {
  const db = app.get<DrizzleDB>(DRIZZLE);
  const suffix = uniq();
  const [category] = await db
    .insert(schema.categories)
    .values({ name: `${name} ${suffix}`, slug: `test-category-${suffix}` })
    .returning();
  return { id: category.id, slug: category.slug };
}

// Full sellable unit: category → product → variant (SKU) → price.
export async function createTestProduct(app: INestApplication, options: TestProductOptions = {}): Promise<TestProduct> {
  const db = app.get<DrizzleDB>(DRIZZLE);
  const suffix = uniq();
  const priceMinor = options.priceMinor ?? 199_000;

  const categoryId = options.categoryId ?? (await createTestCategory(app)).id;

  const [product] = await db
    .insert(schema.products)
    .values({
      name: `Test Product ${suffix}`,
      slug: `test-product-${suffix}`,
      description: 'Fixture product',
      status: options.status ?? 'ACTIVE',
      categoryId,
    })
    .returning();

  const [variant] = await db
    .insert(schema.productVariants)
    .values({ sku: `TEST-SKU-${suffix}`, name: `Test Variant ${suffix}`, productId: product.id })
    .returning();

  const [price] = await db
    .insert(schema.prices)
    .values({ variantId: variant.id, currency: options.currency ?? 'VND', amountMinor: priceMinor })
    .returning();

  return {
    categoryId,
    productId: product.id,
    variantId: variant.id,
    sku: variant.sku,
    priceId: price.id,
    priceMinor,
  };
}
