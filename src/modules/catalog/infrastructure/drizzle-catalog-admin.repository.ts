import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { and, asc, count, eq, max, ne, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB, type DrizzleTx } from '@shared/infrastructure/database';
import { Money } from '@shared/kernel';
import { MEDIA_FACADE, type MediaFacade } from '@modules/media/application/public/media-facade.port';
import { categories, prices, productImages, productVariants, products } from './schema/catalog.schema';
import type { AdminProduct, Category, Price, ProductImage, Sku } from '../domain/entities';
import type {
  AttachImageData,
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

@Injectable()
export class DrizzleCatalogAdminRepository implements CatalogAdminRepositoryPort {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    @Inject(MEDIA_FACADE) private readonly media: MediaFacade,
  ) {}

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

  listImages(productId: string): Promise<ProductImage[]> {
    return this.readImages(this.db, productId);
  }

  // The link row and Media's claim on the asset commit together. Lock order is fixed across all three
  // image operations — `product_images` before `media_assets` — so two concurrent edits of the same
  // asset cannot deadlock on each other's locks.
  async attachImage(productId: string, data: AttachImageData): Promise<ProductImage> {
    return this.db.transaction(async (tx) => {
      const position = data.position ?? (await this.nextPosition(tx, productId));
      const [row] = await this.guardUnique(
        () =>
          tx
            .insert(productImages)
            .values({ productId, assetId: data.assetId, position, alt: data.alt ?? null })
            .returning(),
        'Image already attached to this product',
      );
      await this.media.attach(tx, data.assetId);
      return toProductImage(row);
    });
  }

  async detachImage(productId: string, imageId: string): Promise<ProductImage | null> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .delete(productImages)
        .where(and(eq(productImages.id, imageId), eq(productImages.productId, productId)))
        .returning();
      if (!row) {
        return null;
      }
      await this.media.detach(tx, row.assetId);
      return toProductImage(row);
    });
  }

  async reorderImages(productId: string, imageIds: string[]): Promise<ProductImage[] | null> {
    return this.db.transaction(async (tx) => {
      // Locked before the check so two reorders, or a reorder and a detach, cannot interleave and
      // half-apply each other's order. It does not block a concurrent *insert* — no gap lock — but
      // that costs at most a duplicate position, which `ORDER BY position, id` breaks deterministically.
      const current = await tx
        .select({ id: productImages.id })
        .from(productImages)
        .where(eq(productImages.productId, productId))
        .for('update');

      const known = new Set(current.map((row) => row.id));
      const requested = new Set(imageIds);
      if (requested.size !== imageIds.length || known.size !== requested.size) {
        return null;
      }
      for (const id of requested) {
        if (!known.has(id)) {
          return null;
        }
      }

      for (const [index, id] of imageIds.entries()) {
        await tx.update(productImages).set({ position: index }).where(eq(productImages.id, id));
      }
      return this.readImages(tx, productId);
    });
  }

  private async readImages(db: DrizzleDB | DrizzleTx, productId: string): Promise<ProductImage[]> {
    const rows = await db
      .select()
      .from(productImages)
      .where(eq(productImages.productId, productId))
      .orderBy(asc(productImages.position), asc(productImages.id));
    return rows.map(toProductImage);
  }

  // Gaps are fine — only the relative order of positions is meaningful.
  private async nextPosition(tx: DrizzleTx, productId: string): Promise<number> {
    const [row] = await tx
      .select({ value: max(productImages.position) })
      .from(productImages)
      .where(eq(productImages.productId, productId));
    return (row?.value ?? -1) + 1;
  }

  async setPrice(variantId: string, data: SetPriceData): Promise<Price> {
    // Re-check the Money invariant at the write boundary so a malformed price can never persist and
    // later 500 the read path, which parses the same row back through Money.
    const money = Money.of(data.amountMinor, data.currency);
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

function toProductImage(row: typeof productImages.$inferSelect): ProductImage {
  return {
    id: row.id,
    productId: row.productId,
    assetId: row.assetId,
    position: row.position,
    alt: row.alt,
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
