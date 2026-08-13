import { Inject, Injectable } from '@nestjs/common';
import { and, count, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../../../shared/infrastructure/database';
import { categories, prices, productVariants, products } from './schema/catalog.schema';
import type { Product } from '../domain/entities';
import type { FindManyActiveCriteria, FindManyActiveResult, ProductRepositoryPort } from '../application/ports';
import { assembleProducts } from './product-row.mapper';

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

// Escape LIKE/ILIKE wildcards so a user's `q` cannot inject `%`/`_` patterns.
// Backslash is Postgres' default ILIKE escape char (no ESCAPE clause needed).
function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

// A product id is a UUID; a slug never is. Probe the uuid `id` column only for
// UUID-shaped input — comparing it against a slug throws on Postgres' text→uuid cast.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Drizzle adapter for ProductRepositoryPort — explicit SQL-first joins (readable `EXPLAIN ANALYZE`) with integer money passthrough, and the seam for a future cache-aside layer. */
@Injectable()
export class DrizzleProductRepository implements ProductRepositoryPort {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  async findManyActive(criteria: FindManyActiveCriteria): Promise<FindManyActiveResult> {
    const { page, pageSize, categorySlug, q } = criteria;

    // Live products in live categories only — filtering the inner-joined category here is the
    // authoritative archived-category guard (the write-side check is just the first line).
    const conditions: SQL[] = [eq(products.status, 'ACTIVE'), isNull(categories.archivedAt)];
    if (categorySlug) {
      conditions.push(eq(categories.slug, categorySlug));
    }
    if (q) {
      conditions.push(ilike(products.name, `%${escapeLike(q)}%`));
    }
    const where = and(...conditions);

    // One snapshot for page + count; two-step pagination — LIMIT/OFFSET on products alone
    // (a LIMIT over the flattened join would count join rows), then hydrate that page's ids.
    return this.db.transaction(
      async (tx) => {
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

        // Reorder assembled products to match the page order from the id query.
        const byId = new Map(assembleProducts(rows).map((product) => [product.id, product]));
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

    return assembleProducts(rows)[0] ?? null;
  }
}
