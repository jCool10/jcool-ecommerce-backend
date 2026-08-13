import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { and, count, eq, ne, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../../../shared/infrastructure/database';
import { Money } from '../../../shared/kernel';
import { categories, prices, productVariants, products } from './schema/catalog.schema';
import type { AdminProduct, Category, Price, Sku } from '../domain/entities';
import type {
  CatalogAdminRepositoryPort,
  CreateCategoryData,
  CreateProductData,
  CreateSkuData,
  SetPriceData,
  UpdateCategoryData,
  UpdateProductData,
  UpdateSkuData,
} from '../application/ports';

// Catch the unique-constraint hit (the only race-safe check) rather than pre-SELECT;
// drizzle wraps the driver error, so the pg `code` lives down the `.cause` chain.
const PG_UNIQUE_VIOLATION = '23505';
function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current != null && depth < 5; depth++) {
    if (
      typeof current === 'object' &&
      'code' in current &&
      (current as { code?: unknown }).code === PG_UNIQUE_VIOLATION
    ) {
      return true;
    }
    current = typeof current === 'object' && 'cause' in current ? (current as { cause?: unknown }).cause : undefined;
  }
  return false;
}

/** Drizzle adapter for the Catalog admin write paths — create/update returns the persisted row as a flat domain record; update/archive returns `null` when the id matches no row (the service maps that to 404). */
@Injectable()
export class DrizzleCatalogAdminRepository implements CatalogAdminRepositoryPort {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  // Translate a unique-constraint hit into a 409; anything else propagates.
  private async guardUnique<T>(op: () => Promise<T>, conflictMessage: string): Promise<T> {
    try {
      return await op();
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException(conflictMessage);
      }
      throw error;
    }
  }

  // ----- Category -----

  async findCategoryById(id: string): Promise<Category | null> {
    const [row] = await this.db.select().from(categories).where(eq(categories.id, id)).limit(1);
    return row ? toCategory(row) : null;
  }

  async createCategory(data: CreateCategoryData): Promise<Category> {
    const [row] = await this.guardUnique(
      () =>
        this.db
          .insert(categories)
          .values({ name: data.name, slug: data.slug, parentId: data.parentId ?? null })
          .returning(),
      'Category slug already exists',
    );
    return toCategory(row);
  }

  async updateCategory(id: string, data: UpdateCategoryData): Promise<Category | null> {
    const patch: Partial<typeof categories.$inferInsert> = {};
    if (data.name !== undefined) patch.name = data.name;
    if (data.slug !== undefined) patch.slug = data.slug;
    if (data.parentId !== undefined) patch.parentId = data.parentId;
    if (Object.keys(patch).length === 0) {
      return this.findCategoryById(id);
    }
    const [row] = await this.guardUnique(
      () => this.db.update(categories).set(patch).where(eq(categories.id, id)).returning(),
      'Category slug already exists',
    );
    return row ? toCategory(row) : null;
  }

  async archiveCategory(id: string): Promise<Category | null> {
    // COALESCE keeps the first timestamp → re-archiving is idempotent.
    const [row] = await this.db
      .update(categories)
      .set({ archivedAt: sql`coalesce(${categories.archivedAt}, now())` })
      .where(eq(categories.id, id))
      .returning();
    return row ? toCategory(row) : null;
  }

  async countActiveProductsInCategory(categoryId: string): Promise<number> {
    const [row] = await this.db
      .select({ value: count() })
      .from(products)
      .where(and(eq(products.categoryId, categoryId), ne(products.status, 'ARCHIVED')));
    return row?.value ?? 0;
  }

  // ----- Product -----

  async findProductById(id: string): Promise<AdminProduct | null> {
    const [row] = await this.db.select().from(products).where(eq(products.id, id)).limit(1);
    return row ? toProduct(row) : null;
  }

  async createProduct(data: CreateProductData): Promise<AdminProduct> {
    const [row] = await this.guardUnique(
      () =>
        this.db
          .insert(products)
          .values({
            name: data.name,
            slug: data.slug,
            description: data.description ?? null,
            status: data.status ?? 'DRAFT',
            categoryId: data.categoryId,
          })
          .returning(),
      'Product slug already exists',
    );
    return toProduct(row);
  }

  async updateProduct(id: string, data: UpdateProductData): Promise<AdminProduct | null> {
    const patch: Partial<typeof products.$inferInsert> = {};
    if (data.name !== undefined) patch.name = data.name;
    if (data.slug !== undefined) patch.slug = data.slug;
    if (data.description !== undefined) patch.description = data.description;
    if (data.status !== undefined) patch.status = data.status;
    if (data.categoryId !== undefined) patch.categoryId = data.categoryId;
    if (Object.keys(patch).length === 0) {
      return this.findProductById(id);
    }
    const [row] = await this.guardUnique(
      () => this.db.update(products).set(patch).where(eq(products.id, id)).returning(),
      'Product slug already exists',
    );
    return row ? toProduct(row) : null;
  }

  async archiveProduct(id: string): Promise<AdminProduct | null> {
    const [row] = await this.db.update(products).set({ status: 'ARCHIVED' }).where(eq(products.id, id)).returning();
    return row ? toProduct(row) : null;
  }

  // ----- Sku (product variant) -----

  async findSkuById(id: string): Promise<Sku | null> {
    const [row] = await this.db.select().from(productVariants).where(eq(productVariants.id, id)).limit(1);
    return row ? toSku(row) : null;
  }

  async createSku(productId: string, data: CreateSkuData): Promise<Sku> {
    const [row] = await this.guardUnique(
      () => this.db.insert(productVariants).values({ sku: data.sku, name: data.name, productId }).returning(),
      'SKU code already exists',
    );
    return toSku(row);
  }

  async updateSku(id: string, data: UpdateSkuData): Promise<Sku | null> {
    const patch: Partial<typeof productVariants.$inferInsert> = {};
    if (data.sku !== undefined) patch.sku = data.sku;
    if (data.name !== undefined) patch.name = data.name;
    if (Object.keys(patch).length === 0) {
      return this.findSkuById(id);
    }
    const [row] = await this.guardUnique(
      () => this.db.update(productVariants).set(patch).where(eq(productVariants.id, id)).returning(),
      'SKU code already exists',
    );
    return row ? toSku(row) : null;
  }

  async archiveSku(id: string): Promise<Sku | null> {
    const [row] = await this.db
      .update(productVariants)
      .set({ archivedAt: sql`coalesce(${productVariants.archivedAt}, now())` })
      .where(eq(productVariants.id, id))
      .returning();
    return row ? toSku(row) : null;
  }

  // ----- Price -----

  async setPrice(variantId: string, data: SetPriceData): Promise<Price> {
    // Enforce the Money invariant at the write boundary too (integer amount, canonical currency)
    // so a malformed price can never persist and later 500 the read path — symmetric with the mapper.
    const money = Money.of(data.amountMinor, data.currency);
    // Upsert on the (variant, currency) unique index → idempotent set/replace.
    const [row] = await this.db
      .insert(prices)
      .values({ variantId, currency: money.currency, amountMinor: money.amountMinor })
      // $onUpdate doesn't fire on a conflict SET — bump updated_at by hand.
      .onConflictDoUpdate({
        target: [prices.variantId, prices.currency],
        set: { amountMinor: money.amountMinor, updatedAt: new Date() },
      })
      .returning();
    return { variantId: row.variantId, currency: row.currency, amountMinor: row.amountMinor };
  }
}

// Row -> flat domain record mappers. Kept module-private (not exported) since the
// admin write path is the only consumer.
function toCategory(row: typeof categories.$inferSelect): Category {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    parentId: row.parentId,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
  };
}

function toProduct(row: typeof products.$inferSelect): AdminProduct {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    status: row.status,
    categoryId: row.categoryId,
    createdAt: row.createdAt,
  };
}

function toSku(row: typeof productVariants.$inferSelect): Sku {
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    productId: row.productId,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
  };
}
