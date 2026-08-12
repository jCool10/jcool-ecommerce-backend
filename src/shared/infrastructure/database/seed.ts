import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

// Idempotent Catalog seed: inserts use onConflictDoNothing, then rows are read
// back by natural key (slug/sku) to resolve the generated UUID v7 ids.

// Fail loudly if a prerequisite row is missing instead of inserting bad FKs.
function must<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`Seed precondition failed: ${label} not found`);
  }
  return value;
}

async function seed(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is required to run the seed');
  }
  const pool = new Pool({ connectionString });
  const db = drizzle(pool, { schema });

  try {
    await db
      .insert(schema.categories)
      .values([
        { name: 'Electronics', slug: 'electronics' },
        { name: 'Apparel', slug: 'apparel' },
      ])
      .onConflictDoNothing();

    const categories = await db.select().from(schema.categories);
    const categoryBySlug = new Map(categories.map((c) => [c.slug, c]));

    await db
      .insert(schema.products)
      .values([
        {
          name: 'Wireless Headphones',
          slug: 'wireless-headphones',
          description: 'Over-ear Bluetooth headphones',
          status: 'ACTIVE',
          categoryId: must(categoryBySlug.get('electronics'), 'category:electronics').id,
        },
        {
          name: 'Cotton T-Shirt',
          slug: 'cotton-t-shirt',
          description: 'Basic crew-neck tee',
          status: 'ACTIVE',
          categoryId: must(categoryBySlug.get('apparel'), 'category:apparel').id,
        },
      ])
      .onConflictDoNothing();

    const products = await db.select().from(schema.products);
    const productBySlug = new Map(products.map((p) => [p.slug, p]));
    const headphonesId = must(productBySlug.get('wireless-headphones'), 'product:wireless-headphones').id;
    const tshirtId = must(productBySlug.get('cotton-t-shirt'), 'product:cotton-t-shirt').id;

    await db
      .insert(schema.productVariants)
      .values([
        {
          sku: 'WH-BLK',
          name: 'Wireless Headphones / Black',
          productId: headphonesId,
        },
        {
          sku: 'WH-WHT',
          name: 'Wireless Headphones / White',
          productId: headphonesId,
        },
        { sku: 'TS-M', name: 'Cotton T-Shirt / M', productId: tshirtId },
        { sku: 'TS-L', name: 'Cotton T-Shirt / L', productId: tshirtId },
      ])
      .onConflictDoNothing();

    const variants = await db.select().from(schema.productVariants);
    const variantBySku = new Map(variants.map((v) => [v.sku, v]));

    // Prices in VND, stored as integer đồng (amount_minor). No float.
    await db
      .insert(schema.prices)
      .values([
        {
          variantId: must(variantBySku.get('WH-BLK'), 'sku:WH-BLK').id,
          currency: 'VND',
          amountMinor: 2_490_000,
        },
        {
          variantId: must(variantBySku.get('WH-WHT'), 'sku:WH-WHT').id,
          currency: 'VND',
          amountMinor: 2_490_000,
        },
        {
          variantId: must(variantBySku.get('TS-M'), 'sku:TS-M').id,
          currency: 'VND',
          amountMinor: 199_000,
        },
        {
          variantId: must(variantBySku.get('TS-L'), 'sku:TS-L').id,
          currency: 'VND',
          amountMinor: 199_000,
        },
      ])
      .onConflictDoNothing();

    console.log('Seed complete:', {
      categories: categories.length,
      products: products.length,
      variants: variants.length,
    });
  } finally {
    await pool.end();
  }
}

void seed().catch((error: unknown) => {
  console.error('Seed failed:', error);
  process.exit(1);
});
