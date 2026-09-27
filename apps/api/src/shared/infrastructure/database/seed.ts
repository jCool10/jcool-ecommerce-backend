import 'dotenv/config';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { UNOWNED_BUCKET } from '@shared/identity/id-generator.port';
import * as schema from './schema';
import { withScriptsMintLock } from './scripts-mint-lock';

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
    await withScriptsMintLock(pool, (mint) => seedCatalog(db, () => mint(UNOWNED_BUCKET)));
  } finally {
    await pool.end();
  }
}

async function seedCatalog(db: NodePgDatabase<typeof schema>, id: () => string): Promise<void> {
  await db
    .insert(schema.categories)
    .values([
      { id: id(), name: 'Electronics', slug: 'electronics' },
      { id: id(), name: 'Apparel', slug: 'apparel' },
    ])
    .onConflictDoNothing();

  const categories = await db.select().from(schema.categories);
  const categoryBySlug = new Map(categories.map((c) => [c.slug, c]));

  await db
    .insert(schema.products)
    .values([
      {
        id: id(),
        name: 'Wireless Headphones',
        slug: 'wireless-headphones',
        description: 'Over-ear Bluetooth headphones',
        status: 'ACTIVE',
        categoryId: must(categoryBySlug.get('electronics'), 'category:electronics').id,
      },
      {
        id: id(),
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
      { id: id(), sku: 'WH-BLK', name: 'Wireless Headphones / Black', productId: headphonesId },
      { id: id(), sku: 'WH-WHT', name: 'Wireless Headphones / White', productId: headphonesId },
      { id: id(), sku: 'TS-M', name: 'Cotton T-Shirt / M', productId: tshirtId },
      { id: id(), sku: 'TS-L', name: 'Cotton T-Shirt / L', productId: tshirtId },
    ])
    .onConflictDoNothing();

  const variants = await db.select().from(schema.productVariants);
  const variantBySku = new Map(variants.map((v) => [v.sku, v]));
  const priced = (sku: string, amountMinor: number) => ({
    id: id(),
    variantId: must(variantBySku.get(sku), `sku:${sku}`).id,
    currency: 'VND',
    amountMinor,
  });

  await db
    .insert(schema.prices)
    .values([
      priced('WH-BLK', 2_490_000),
      priced('WH-WHT', 2_490_000),
      priced('TS-M', 199_000),
      priced('TS-L', 199_000),
    ])
    .onConflictDoNothing();

  // Checkout reserves stock, so every variant needs an on-hand row or `POST /orders` 409s. On-hand
  // is effectively unlimited so load tests never deplete it (held stock isn't released within a
  // run); real inventory is managed elsewhere, and this never clobbers a live count or its holds.
  await db
    .insert(schema.stockLevels)
    .values(variants.map((v) => ({ id: id(), variantId: v.id, quantityOnHand: 1_000_000_000 })))
    .onConflictDoNothing();

  console.log('Seed complete:', {
    categories: categories.length,
    products: products.length,
    variants: variants.length,
    stockLevels: variants.length,
  });
}

void seed().catch((error: unknown) => {
  console.error('Seed failed:', error);
  process.exit(1);
});
