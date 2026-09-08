import { Inject, Injectable } from '@nestjs/common';
import { and, count, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB, type DrizzleTx } from '@shared/infrastructure/database';
import { categories, prices, productImages, productVariants, products } from './schema/catalog.schema';
import type { Product, ProductStatus } from '../domain/entities';
import type { FindManyActiveCriteria, FindManyActiveResult, ProductRepositoryPort } from '../application/ports';
import type { SkuView } from '../application/public/catalog-sku-query.port';
import { assembleProducts } from './product-row.mapper';

// System default pricing currency (schema default + admin write default). The SKU
// view reads the price in this currency; a SKU priced only in another currency
// reads as unpriced here — acceptable while VND is the sole currency.
const DEFAULT_CURRENCY = 'VND';

// Column projection for the flattened product×variant×price read, shared by the
// list and detail queries (matches ProductFlatRow). Left-joined columns are nullable.
const flatColumns = {
  productId: products.id,
  productName: products.name,
  productSlug: products.slug,
  productDescription: products.description,
  productStatus: products.status,
  productCreatedAt: products.createdAt,
  categorySlug: categories.slug,
  categoryName: categories.name,
  variantId: productVariants.id,
  variantSku: productVariants.sku,
  variantName: productVariants.name,
  priceId: prices.id,
  priceCurrency: prices.currency,
  priceAmountMinor: prices.amountMinor,
};

// `uq_prices_variant_currency` is what keeps a many-id read from fanning a SKU out into duplicate
// rows; the left join is what keeps an unpriced SKU resolvable. Only the projection is shared below —
// the two reads repeat the joins and the id predicate, so a change to one must be mirrored in the
// other or `POST /cart/items` and `GET /cart` will disagree on whether a SKU exists.
const skuViewColumns = {
  skuId: productVariants.id,
  productName: products.name,
  productStatus: products.status,
  variantArchivedAt: productVariants.archivedAt,
  amountMinor: prices.amountMinor,
  currency: prices.currency,
};

interface SkuViewRow {
  skuId: string;
  productName: string;
  productStatus: ProductStatus;
  variantArchivedAt: Date | null;
  amountMinor: number | null;
  currency: string | null;
}

function toSkuView(row: SkuViewRow): SkuView {
  return {
    skuId: row.skuId,
    productName: row.productName,
    unitPriceMinor: row.amountMinor ?? null,
    currency: row.currency ?? DEFAULT_CURRENCY,
    isActive: row.productStatus === 'ACTIVE' && row.variantArchivedAt === null,
  };
}

// Escape LIKE/ILIKE wildcards so a user's `q` cannot inject `%`/`_` patterns.
// Backslash is Postgres' default ILIKE escape char (no ESCAPE clause needed).
function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

// A product id is a UUID; a slug never is. Probe the uuid `id` column only for
// UUID-shaped input — comparing it against a slug throws on Postgres' text→uuid cast.
// Exported because the cache keys must normalise exactly the tokens this treats as ids.
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Image asset ids per product, in display order. A separate keyed read rather than a fourth join:
 * images multiply against variants and prices, and every price would then be counted once per image.
 */
async function loadImageAssetIds(db: DrizzleDB | DrizzleTx, productIds: string[]): Promise<Map<string, string[]>> {
  const byProduct = new Map<string, string[]>();
  if (productIds.length === 0) {
    return byProduct;
  }

  const rows = await db
    .select({ productId: productImages.productId, assetId: productImages.assetId })
    .from(productImages)
    .where(inArray(productImages.productId, productIds))
    .orderBy(productImages.position, productImages.id);

  for (const row of rows) {
    const assetIds = byProduct.get(row.productId);
    if (assetIds) {
      assetIds.push(row.assetId);
    } else {
      byProduct.set(row.productId, [row.assetId]);
    }
  }
  return byProduct;
}

/** Drizzle adapter for ProductRepositoryPort — explicit SQL-first joins (readable `EXPLAIN ANALYZE`) with integer money passthrough, and the seam for a future cache-aside layer. */
@Injectable()
export class DrizzleProductRepository implements ProductRepositoryPort {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  async findManyActive(criteria: FindManyActiveCriteria): Promise<FindManyActiveResult> {
    const { page, pageSize, categorySlug, q } = criteria;

    // One snapshot for page + count; two-step pagination — LIMIT/OFFSET on products alone
    // (a LIMIT over the flattened join would count join rows), then hydrate that page's ids.
    return this.db.transaction(
      async (tx) => {
        // Live products in live categories only — filtering the inner-joined category here is the
        // authoritative archived-category guard (the write-side check is just the first line).
        const conditions: SQL[] = [eq(products.status, 'ACTIVE'), isNull(categories.archivedAt)];
        if (categorySlug) {
          // Filtered across the join, `categories.slug` leaves the planner with only the average
          // category size, so it scans the whole ordered ACTIVE index; binding the id lets it seek.
          const [category] = await tx
            .select({ id: categories.id })
            .from(categories)
            .where(eq(categories.slug, categorySlug))
            .limit(1);
          if (!category) {
            return { items: [], total: 0 };
          }
          conditions.push(eq(products.categoryId, category.id));
        }
        if (q) {
          conditions.push(ilike(products.name, `%${escapeLike(q)}%`));
        }
        const where = and(...conditions);

        const idRows = await tx
          .select({ id: products.id })
          .from(products)
          .innerJoin(categories, eq(products.categoryId, categories.id))
          .where(where)
          .orderBy(desc(products.createdAt), desc(products.id))
          .limit(pageSize)
          .offset((page - 1) * pageSize);
        const ids = idRows.map((row) => row.id);

        const totalRows = await tx
          .select({ value: count() })
          .from(products)
          .innerJoin(categories, eq(products.categoryId, categories.id))
          .where(where);
        const total = totalRows[0]?.value ?? 0;

        if (ids.length === 0) {
          return { items: [], total };
        }

        const rows = await tx
          .select(flatColumns)
          .from(products)
          .innerJoin(categories, eq(products.categoryId, categories.id))
          // Exclude archived variants in the JOIN so the product still lists but
          // its dead SKUs do not.
          .leftJoin(
            productVariants,
            and(eq(productVariants.productId, products.id), isNull(productVariants.archivedAt)),
          )
          .leftJoin(prices, eq(prices.variantId, productVariants.id))
          .where(inArray(products.id, ids))
          .orderBy(
            desc(products.createdAt),
            desc(products.id),
            productVariants.createdAt,
            productVariants.id,
            prices.currency,
          );

        const images = await loadImageAssetIds(tx, ids);

        // Reorder assembled products to match the page order from the id query.
        const byId = new Map(assembleProducts(rows, images).map((product) => [product.id, product]));
        const items = ids.map((id) => byId.get(id)).filter((product): product is Product => product !== undefined);

        return { items, total };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }

  async findActiveByIdOrSlug(idOrSlug: string): Promise<Product | null> {
    const byId = UUID_PATTERN.test(idOrSlug);
    const rows = await this.db
      .select(flatColumns)
      .from(products)
      .innerJoin(categories, eq(products.categoryId, categories.id))
      // Exclude archived variants from the public detail.
      .leftJoin(productVariants, and(eq(productVariants.productId, products.id), isNull(productVariants.archivedAt)))
      .leftJoin(prices, eq(prices.variantId, productVariants.id))
      // A live product in an archived category is 404 here too (same as list).
      .where(
        and(
          eq(products.status, 'ACTIVE'),
          isNull(categories.archivedAt),
          byId ? or(eq(products.id, idOrSlug), eq(products.slug, idOrSlug)) : eq(products.slug, idOrSlug),
        ),
      )
      // Id-precedence: when the input is a UUID and one product's slug equals another's
      // id, the exact id match sorts first so assembleProducts()[0] is the id winner.
      .orderBy(
        ...(byId ? [sql`case when ${products.id} = ${idOrSlug} then 0 else 1 end`] : []),
        productVariants.createdAt,
        productVariants.id,
        prices.currency,
      );

    // Which product won is only known after assembly (id-precedence above), and the images query
    // needs that id — so assemble twice rather than fetch images for every candidate.
    const product = assembleProducts(rows)[0];
    if (!product) {
      return null;
    }
    return assembleProducts(rows, await loadImageAssetIds(this.db, [product.id]))[0] ?? null;
  }

  // Neither this read nor `findManySkuViews` filters on ACTIVE: a SKU whose product was archived
  // after it was added still resolves, flagged isActive=false — the cart shows it, Order
  // re-validates at checkout.
  async findSkuView(skuId: string): Promise<SkuView | null> {
    const [row] = await this.db
      .select(skuViewColumns)
      .from(productVariants)
      .innerJoin(products, eq(productVariants.productId, products.id))
      .leftJoin(prices, and(eq(prices.variantId, productVariants.id), eq(prices.currency, DEFAULT_CURRENCY)))
      .where(eq(productVariants.id, skuId))
      .limit(1);

    return row ? toSkuView(row) : null;
  }

  async findManySkuViews(skuIds: string[]): Promise<SkuView[]> {
    // An empty cart must not cost a round-trip; drizzle would otherwise emit a valid `WHERE false`.
    if (skuIds.length === 0) {
      return [];
    }

    const rows = await this.db
      .select(skuViewColumns)
      .from(productVariants)
      .innerJoin(products, eq(productVariants.productId, products.id))
      .leftJoin(prices, and(eq(prices.variantId, productVariants.id), eq(prices.currency, DEFAULT_CURRENCY)))
      .where(inArray(productVariants.id, skuIds));

    return rows.map(toSkuView);
  }
}
