/**
 * Catalog + cart seeder at a scale where the Postgres planner has a real choice: below a few hundred
 * rows a Seq Scan is always cheapest, so anything measured against the demo seed is an artifact.
 * Prefixed natural keys + ON CONFLICT DO NOTHING mean a re-run tops up and `--clean` can never take
 * a real product with it.
 *
 * `--clean` does NOT remove what a load run produces — orders, reservations, outbox rows, the
 * accounts k6 registers. For a true reset: `docker compose down -v` then `npm run db:migrate`.
 *
 * Leaves Redis alone: the public read path is cached behind a generation counter only an admin write
 * bumps, so an app already serving pre-seed pages keeps serving them — the final log line says how.
 */
import 'dotenv/config';
import * as argon2 from 'argon2';
import { and, eq, inArray, like, notInArray, sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { categories, prices, productVariants, products } from '@modules/catalog/infrastructure/schema/catalog.schema';
import { CATALOG_CACHE_VERSION_KEY } from '@modules/catalog/infrastructure/catalog-cache.keys';
import { cartItems, carts } from '@modules/cart/infrastructure/schema/cart.schema';
import { stockLevels } from '@modules/inventory/infrastructure/schema/inventory.schema';
import { users } from '@modules/user/infrastructure/schema/user.schema';
import { IdentityService, SCRIPTS_NODE_ID, UuidV8Generator } from '@shared/identity';
import { normalizeEmail } from '@shared/kernel/normalize-email';

const CATEGORY_SLUG_PREFIX = 'perf-cat-';
const PRODUCT_SLUG_PREFIX = 'perf-prod-';
const SKU_PREFIX = 'PERF-';
// Normalized here so the insert, the lookups, the cleanup and the bucket derivation share bytes.
const PERF_USER_EMAIL = normalizeEmail('perf@loadtest.jcool.local');

// This account authenticates over HTTP (unlike the bulk seeder's rows), so the credential is
// overridable rather than fixed in a committed file. The default is for a throwaway database only.
function perfUserPassword(): string {
  return process.env.PERF_USER_PASSWORD ?? 'perf-load-not-a-real-secret';
}

// Must be the app's own key: seeding under another writes an account whose id routes to a bucket its
// email does not, which nothing notices until a shard split. Refuse rather than invent a default.
function identity(): IdentityService {
  const bucketKey = process.env.IDENTITY_BUCKET_KEY;
  if (!bucketKey) throw new Error('IDENTITY_BUCKET_KEY is required to mint the perf user id');
  return new IdentityService(UuidV8Generator.create({ nodeId: SCRIPTS_NODE_ID }), bucketKey);
}

const CATEGORY_COUNT = 20;
// Two archived categories give the public read path rows it must filter out — without them the
// category join never rejects anything and the plan is unrealistically clean.
const ARCHIVED_CATEGORIES = 2;
// Rows per INSERT. Widest table is products at 7 bound columns, so 1000 rows stays far under
// Postgres' 65535-parameter cap while keeping the statement count low.
const CHUNK = 1000;
const CURRENCY = 'VND';
// Effectively unlimited on-hand: placement reserves stock and a load run never releases its holds,
// so a realistic count would deplete mid-run and turn the write path into 409s.
const STOCK_ON_HAND = 1_000_000_000;

type Db = NodePgDatabase<Record<string, never>>;

function intEnv(name: string, fallback: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  // `Number`, not `parseInt`: parseInt('20abc') is 20, so a typo would silently seed the wrong scale.
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new Error(`${name} must be an integer in 1..${max}, got "${raw}"`);
  }
  return parsed;
}

function* chunks<T>(rows: readonly T[], size: number): Generator<T[]> {
  for (let i = 0; i < rows.length; i += size) {
    yield rows.slice(i, i + size);
  }
}

// ~90% ACTIVE with a tail of DRAFT/ARCHIVED, so a partial index on ACTIVE is measurably smaller
// than the table instead of covering all of it.
function statusFor(i: number): 'ACTIVE' | 'DRAFT' | 'ARCHIVED' {
  const bucket = i % 20;
  if (bucket === 18) return 'DRAFT';
  if (bucket === 19) return 'ARCHIVED';
  return 'ACTIVE';
}

// The list page sorts by (created_at DESC, id DESC). Rows all sharing one defaultNow() timestamp
// would collapse that sort to a tiebreak on id and hide what the composite index is for, so
// timestamps are spread backwards, one minute apart, deterministically.
function createdAtFor(i: number, epoch: number): Date {
  return new Date(epoch - i * 60_000);
}

function variantCountFor(i: number): number {
  return (i % 3) + 1;
}

function priceFor(i: number): number {
  return 50_000 + (i % 500) * 1_000;
}

async function seedCategories(db: Db): Promise<Map<string, string>> {
  const rows = Array.from({ length: CATEGORY_COUNT }, (_, i) => ({
    name: `Perf Category ${i}`,
    slug: `${CATEGORY_SLUG_PREFIX}${i}`,
    archivedAt: i < ARCHIVED_CATEGORIES ? new Date() : null,
  }));
  await db.insert(categories).values(rows).onConflictDoNothing();

  const stored = await db
    .select({ id: categories.id, slug: categories.slug })
    .from(categories)
    .where(like(categories.slug, `${CATEGORY_SLUG_PREFIX}%`));
  return new Map(stored.map((c) => [c.slug, c.id]));
}

async function seedProducts(db: Db, scale: number, categoryIds: Map<string, string>): Promise<Map<string, string>> {
  const epoch = Date.now();
  const rows = Array.from({ length: scale }, (_, i) => {
    const categorySlug = `${CATEGORY_SLUG_PREFIX}${i % CATEGORY_COUNT}`;
    const categoryId = categoryIds.get(categorySlug);
    if (!categoryId) throw new Error(`Seed precondition failed: category ${categorySlug} not found`);
    return {
      name: `Perf Product ${i}`,
      slug: `${PRODUCT_SLUG_PREFIX}${i}`,
      description: `Synthetic catalog row ${i} for database performance measurement.`,
      status: statusFor(i),
      categoryId,
      createdAt: createdAtFor(i, epoch),
    };
  });

  for (const chunk of chunks(rows, CHUNK)) {
    await db.insert(products).values(chunk).onConflictDoNothing();
  }

  const stored = await db
    .select({ id: products.id, slug: products.slug })
    .from(products)
    .where(like(products.slug, `${PRODUCT_SLUG_PREFIX}%`));
  return new Map(stored.map((p) => [p.slug, p.id]));
}

async function seedVariants(db: Db, scale: number, productIds: Map<string, string>): Promise<string[]> {
  const rows: { sku: string; name: string; productId: string }[] = [];
  for (let i = 0; i < scale; i++) {
    const productId = productIds.get(`${PRODUCT_SLUG_PREFIX}${i}`);
    if (!productId) throw new Error(`Seed precondition failed: product ${PRODUCT_SLUG_PREFIX}${i} not found`);
    for (let v = 0; v < variantCountFor(i); v++) {
      rows.push({ sku: `${SKU_PREFIX}${i}-${v}`, name: `Perf Product ${i} / Variant ${v}`, productId });
    }
  }

  for (const chunk of chunks(rows, CHUNK)) {
    await db.insert(productVariants).values(chunk).onConflictDoNothing();
  }

  // Ordered so `priceFor(i)` maps the same price onto the same SKU on every run — an unordered
  // read-back would make the price distribution differ between otherwise identical seeds.
  const stored = await db
    .select({ id: productVariants.id })
    .from(productVariants)
    .where(like(productVariants.sku, `${SKU_PREFIX}%`))
    .orderBy(productVariants.sku);
  return stored.map((v) => v.id);
}

async function seedPricesAndStock(db: Db, variantIds: readonly string[]): Promise<void> {
  const priceRows = variantIds.map((variantId, i) => ({
    variantId,
    currency: CURRENCY,
    amountMinor: priceFor(i),
  }));
  for (const chunk of chunks(priceRows, CHUNK)) {
    await db.insert(prices).values(chunk).onConflictDoNothing();
  }

  const stockRows = variantIds.map((variantId) => ({ variantId, quantityOnHand: STOCK_ON_HAND }));
  for (const chunk of chunks(stockRows, CHUNK)) {
    await db.insert(stockLevels).values(chunk).onConflictDoNothing();
  }
}

// The cart is deliberately fat, so `GET /cart` shows the per-line SKU fan-out.
async function seedPerfUserCart(db: Db, cartLines: number): Promise<{ userId: string; lines: number }> {
  let [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, PERF_USER_EMAIL));
  if (!user) {
    // Hashed only when the account is actually being created — argon2id is deliberately slow, and
    // a re-run must not burn that cost to produce a digest ON CONFLICT would discard anyway.
    const passwordHash = await argon2.hash(perfUserPassword(), { type: argon2.argon2id });
    await db
      .insert(users)
      .values({
        id: identity().mintUserId(PERF_USER_EMAIL),
        email: PERF_USER_EMAIL,
        passwordHash,
        emailVerifiedAt: new Date(),
      })
      .onConflictDoNothing();
    [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, PERF_USER_EMAIL));
  }
  if (!user) throw new Error(`Seed precondition failed: user ${PERF_USER_EMAIL} not found`);

  await db.insert(carts).values({ userId: user.id }).onConflictDoNothing();
  const [cart] = await db.select({ id: carts.id }).from(carts).where(eq(carts.userId, user.id));
  if (!cart) throw new Error(`Seed precondition failed: cart for ${PERF_USER_EMAIL} not found`);

  // Priced, live SKUs only: an unpriced or archived line still renders, but it would not exercise
  // the price lookup the fan-out is being measured on.
  const lineSkus = await db
    .select({ id: productVariants.id })
    .from(productVariants)
    .innerJoin(products, eq(productVariants.productId, products.id))
    .innerJoin(prices, eq(prices.variantId, productVariants.id))
    .where(sql`${products.status} = 'ACTIVE' and ${productVariants.sku} like ${`${SKU_PREFIX}%`}`)
    .orderBy(productVariants.sku)
    .limit(cartLines);
  if (lineSkus.length < cartLines) {
    throw new Error(`Seed precondition failed: need ${cartLines} priced ACTIVE SKUs, found ${lineSkus.length}`);
  }

  const wanted = lineSkus.map((sku) => sku.id);
  for (const chunk of chunks(
    wanted.map((skuId, i) => ({ cartId: cart.id, skuId, quantity: (i % 3) + 1 })),
    CHUNK,
  )) {
    await db.insert(cartItems).values(chunk).onConflictDoNothing();
  }

  // A previous run at a larger CART_LINES leaves extra lines that ON CONFLICT DO NOTHING will not
  // remove. Cart-view cost is linear in line count, so a cart that silently kept 100 lines when 30
  // were asked for would be measured against the wrong workload.
  await db.delete(cartItems).where(and(eq(cartItems.cartId, cart.id), notInArray(cartItems.skuId, wanted)));

  const [{ value: lines }] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(cartItems)
    .where(eq(cartItems.cartId, cart.id));
  return { userId: user.id, lines };
}

async function clean(db: Db): Promise<void> {
  const perfVariants = await db
    .select({ id: productVariants.id })
    .from(productVariants)
    .where(like(productVariants.sku, `${SKU_PREFIX}%`));
  const variantIds = perfVariants.map((v) => v.id);

  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, PERF_USER_EMAIL));
  if (user) {
    // cart_items cascade from carts; the user row has no FK to either (cross-context boundary).
    await db.delete(carts).where(eq(carts.userId, user.id));
    await db.delete(users).where(eq(users.id, user.id));
  }

  // Children before parents: prices and stock levels reference the variants being removed, and
  // stock_levels has no FK to enforce that order for us.
  for (const chunk of chunks(variantIds, CHUNK)) {
    await db.delete(prices).where(inArray(prices.variantId, chunk));
    await db.delete(stockLevels).where(inArray(stockLevels.variantId, chunk));
  }
  await db.delete(productVariants).where(like(productVariants.sku, `${SKU_PREFIX}%`));
  await db.delete(products).where(like(products.slug, `${PRODUCT_SLUG_PREFIX}%`));
  await db.delete(categories).where(like(categories.slug, `${CATEGORY_SLUG_PREFIX}%`));

  console.log(
    `Cleaned synthetic perf rows (${variantIds.length} SKUs, prefix '${SKU_PREFIX}' / '${PRODUCT_SLUG_PREFIX}').`,
  );
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required to run the perf seed');
  // Coarse guard only — it reads the runtime flag, not the target, so a DATABASE_URL pointed
  // somewhere real still passes. Point this at a throwaway database, never a shared one.
  if (process.env.NODE_ENV === 'production') {
    throw new Error('perf-seed refuses to run with NODE_ENV=production (throwaway data only)');
  }

  const pool = new Pool({ connectionString, max: 4 });
  const db = drizzle(pool);

  try {
    if (process.argv.includes('--clean')) {
      await clean(db);
      return;
    }

    // Every row is materialized in memory before insert, so the ceiling is Node's heap, not
    // Postgres — an unbounded SCALE OOMs the script long before the database objects.
    const scale = intEnv('SCALE', 20_000, 1_000_000);
    const cartLines = intEnv('CART_LINES', 30, 10_000);
    const startedAt = Date.now();

    const categoryIds = await seedCategories(db);
    console.log(`  categories: ${categoryIds.size}`);
    const productIds = await seedProducts(db, scale, categoryIds);
    console.log(`  products:   ${productIds.size}`);
    const variantIds = await seedVariants(db, scale, productIds);
    console.log(`  variants:   ${variantIds.length}`);
    await seedPricesAndStock(db, variantIds);
    console.log(`  prices + stock levels: ${variantIds.length} each`);
    const cart = await seedPerfUserCart(db, cartLines);
    console.log(`  cart:       ${cart.lines} lines for ${PERF_USER_EMAIL} (user ${cart.userId})`);

    // Autovacuum has not run yet, so without this the planner still describes the pre-seed table
    // and every EXPLAIN taken afterwards is read off stats for data that is no longer there.
    await db.execute(sql`analyze categories, products, product_variants, prices, stock_levels, carts, cart_items`);
    console.log('  analyzed:   planner stats refreshed');

    const secs = (Date.now() - startedAt) / 1000;
    console.log(
      `\nPerf seed complete in ${secs.toFixed(1)}s (SCALE=${scale}, CART_LINES=${cartLines}).\n` +
        `Login as ${PERF_USER_EMAIL} (password from PERF_USER_PASSWORD, or the script's default).\n` +
        `Bump the catalog cache generation before measuring — a direct write does not invalidate it,\n` +
        `so reads keep being served from the generation cached before this seed:\n` +
        `  docker compose exec redis redis-cli INCR ${CATALOG_CACHE_VERSION_KEY}\n` +
        `Remove the synthetic rows with: npm run db:seed:perf -- --clean`,
    );
  } finally {
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  console.error('Perf seed failed:', error);
  process.exit(1);
});
