import type { INestApplication } from '@nestjs/common';
import { eq, inArray } from 'drizzle-orm';
import type { Pool } from 'pg';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { PRODUCT_SEARCH_STATE, type ProductSearchStatePort } from '../../src/modules/catalog/application/ports';
import type { Product } from '../../src/modules/catalog/domain/entities';
import { DrizzleProductRepository } from '../../src/modules/catalog/infrastructure';
import type { DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import {
  archiveProduct,
  archiveTestCategory,
  createTestCategory,
  createTestProduct,
  type TestProduct,
} from '../setup/fixtures/catalog.fixture';
import { closeAppAfterAll, createTestAppWithPool, resetDatabaseBeforeEach } from '../setup/harness';

const ABSENT_UUID = '0197c8f4-3a1b-7c2d-8e4f-1a2b3c4d5e6f';

type HydrateActive = (tx: unknown, ids: string[]) => Promise<Map<string, Product>>;

describe('Product search state (integration, real Postgres)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;
  let state: ProductSearchStatePort;
  let products: DrizzleProductRepository;

  beforeAll(async () => {
    ({ app, pool, db } = await createTestAppWithPool());
    state = app.get<ProductSearchStatePort>(PRODUCT_SEARCH_STATE);
    products = app.get(DrizzleProductRepository);
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  async function setVersion(productId: string, version: number): Promise<void> {
    await db.update(schema.products).set({ searchVersion: version }).where(eq(schema.products.id, productId));
  }

  it('returns the public projection and the row version of an ACTIVE product in a live category', async () => {
    const product = await createTestProduct(app);
    await db
      .insert(schema.productImages)
      .values({ productId: product.productId, assetId: crypto.randomUUID(), position: 0 });
    await setVersion(product.productId, 7);

    const [found] = await state.findByIds([product.productId]);

    expect(found).toMatchObject({ id: product.productId, version: 7 });
    expect(found.product).not.toBeNull();
    expect(found.product?.variants).toHaveLength(1);
    expect(found.product?.imageAssetIds).toHaveLength(1);
    expect(found.product).toEqual(await products.findActiveByIdOrSlug(product.productId));
  });

  const hiddenFromPublic: [string, (product: TestProduct) => Promise<void>][] = [
    [
      'is moved back to DRAFT',
      async (product) => {
        await db.update(schema.products).set({ status: 'DRAFT' }).where(eq(schema.products.id, product.productId));
      },
    ],
    ['is archived', (product) => archiveProduct(app, product.productId)],
    ['stays ACTIVE under an archived category', (product) => archiveTestCategory(app, product.categoryId)],
  ];

  it.each(hiddenFromPublic)('returns a null projection but keeps the version once the product %s', async (_, hide) => {
    const product = await createTestProduct(app);
    await setVersion(product.productId, 3);
    const [before] = await state.findByIds([product.productId]);
    expect(before.product?.id).toBe(product.productId);

    await hide(product);

    expect(await state.findByIds([product.productId])).toEqual([{ id: product.productId, version: 3, product: null }]);
  });

  it('reads the version and the projection from one snapshot when a write commits between them', async () => {
    const product = await createTestProduct(app);
    const target = DrizzleProductRepository.prototype as unknown as { hydrateActive: HydrateActive };
    const hydrate = target.hydrateActive;
    const spy = vi.spyOn(target, 'hydrateActive').mockImplementationOnce(async function (this: unknown, ...args) {
      await db
        .update(schema.products)
        .set({ name: 'Renamed mid-read', searchVersion: 1 })
        .where(eq(schema.products.id, product.productId));
      return hydrate.apply(this, args);
    });

    try {
      const [during] = await state.findByIds([product.productId]);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(during).toMatchObject({ version: 0, product: { name: product.name } });
    } finally {
      spy.mockRestore();
    }

    const [after] = await state.findByIds([product.productId]);
    expect(after).toMatchObject({ version: 1, product: { name: 'Renamed mid-read' } });
  });

  it('leaves an unknown id out and still returns the known ones', async () => {
    const active = await createTestProduct(app);
    const draft = await createTestProduct(app, { status: 'DRAFT' });

    const found = await state.findByIds([active.productId, ABSENT_UUID, draft.productId]);

    expect(found.map((entry) => entry.id).sort()).toEqual([active.productId, draft.productId].sort());
    expect(found.find((entry) => entry.id === active.productId)?.product?.id).toBe(active.productId);
    expect(found.find((entry) => entry.id === draft.productId)?.product).toBeNull();
    expect(found.some((entry) => entry.id === ABSENT_UUID)).toBe(false);
  });

  describe('bumpCategoryProducts', () => {
    async function versionsOf(productIds: string[]): Promise<Record<string, number>> {
      const rows = await db
        .select({ id: schema.products.id, version: schema.products.searchVersion })
        .from(schema.products)
        .where(inArray(schema.products.id, productIds));
      return Object.fromEntries(rows.map((row) => [row.id, row.version]));
    }

    const ascendingIds = (howMany: number): string[] =>
      Array.from({ length: howMany }, () => crypto.randomUUID()).sort();

    // Stored in the order given. The cases give the highest id first, so storage order runs against
    // id order and only the ORDER BY yields ascending pages.
    async function insertProducts(rows: [id: string, categoryId: string][]): Promise<void> {
      await db
        .insert(schema.products)
        .values(rows.map(([id, categoryId]) => ({ id, categoryId, name: `Paged ${id}`, slug: `paged-${id}` })));
    }

    it('bumps a category in ascending id pages until none is left, each product once', async () => {
      const category = await createTestCategory(app);
      const ids = ascendingIds(5);
      await insertProducts([...ids].reverse().map((id) => [id, category.id]));

      const pages: string[][] = [];
      let after: string | null = null;
      for (let i = 0; i < 4; i += 1) {
        const page = await state.bumpCategoryProducts(category.id, after, 2);
        pages.push(page);
        after = page.at(-1) ?? after;
      }

      expect(pages).toEqual([[ids[0], ids[1]], [ids[2], ids[3]], [ids[4]], []]);
      expect(await versionsOf(ids)).toEqual(Object.fromEntries(ids.map((id) => [id, 1])));
    });

    it('never returns or bumps a product of another category', async () => {
      const [mine, theirs] = [await createTestCategory(app), await createTestCategory(app)];
      const [first, other, last] = ascendingIds(3);
      await insertProducts([
        [last, mine.id],
        [other, theirs.id],
        [first, mine.id],
      ]);

      expect(await state.bumpCategoryProducts(mine.id, null, 10)).toEqual([first, last]);
      expect(await versionsOf([first, other, last])).toEqual({ [first]: 1, [other]: 0, [last]: 1 });
    });
  });
});
