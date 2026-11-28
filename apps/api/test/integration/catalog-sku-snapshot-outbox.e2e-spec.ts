import type { INestApplication } from '@nestjs/common';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Pool } from 'pg';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CATALOG_SKU_SNAPSHOT_EVENT,
  type CatalogSkuSnapshotPayload,
  isCatalogSkuSnapshotPayload,
} from '@jcool/internal-contracts/events/catalog-sku-snapshot';
import { publishSkuSnapshots } from '../../src/modules/product/infrastructure/catalog/sku-snapshot/publish-sku-snapshots-runner';
import { SkuSnapshotPublisher } from '../../src/modules/product/infrastructure/catalog/sku-snapshot/sku-snapshot.publisher';
import { ID_GENERATOR, type IdGeneratorPort } from '../../src/shared/identity/id-generator.port';
import type { DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import { authHeader } from '../setup/bearer.helper';
import { createTestCategory, createTestProduct, type TestProduct } from '../setup/fixtures/catalog.fixture';
import { createTestAdminPrincipal, type TestPrincipal } from '../setup/fixtures/principal.fixture';
import { closeAppAfterAll, createTestAppWithPool, resetDatabaseBeforeEach } from '../setup/harness';
import { testId } from '../setup/id-service-stub';

const PRODUCT_CHANGED_EVENT = 'catalog.product.changed';
const CONCURRENT_PRICE_WRITES = 6;

let seq = 0;
const uniq = (): string => `${Date.now()}-${seq++}`;

const byVersion = (a: CatalogSkuSnapshotPayload, b: CatalogSkuSnapshotPayload) => a.version - b.version;

type SnapshotSku = CatalogSkuSnapshotPayload['skus'][number];

const view = (skuId: string, unitPriceMinor: number | null, isActive = true): SnapshotSku => ({
  skuId,
  unitPriceMinor,
  currency: 'VND',
  isActive,
});

const inSkuOrder = (snapshot: CatalogSkuSnapshotPayload | undefined): CatalogSkuSnapshotPayload | undefined =>
  snapshot && {
    ...snapshot,
    skus: [...snapshot.skus].sort((a, b) => (BigInt(a.skuId) < BigInt(b.skuId) ? -1 : 1)),
  };

describe('Catalog SKU snapshot outbox emission (integration, real Postgres)', () => {
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;
  let admin: TestPrincipal;

  beforeAll(async () => {
    ({ app, pool, db } = await createTestAppWithPool());
  });
  closeAppAfterAll(() => app);
  resetDatabaseBeforeEach(() => pool);

  beforeEach(async () => {
    admin = await createTestAdminPrincipal(app);
  });

  const send = (method: 'post' | 'patch' | 'put' | 'delete', path: string, body?: object): request.Test => {
    const req = request(app.getHttpServer())[method](path).set(authHeader(admin.accessToken));
    return body ? req.send(body) : req;
  };

  const eventsOf = async (productId: string, eventType: string) =>
    db
      .select({ payload: schema.outbox.payload })
      .from(schema.outbox)
      .where(and(eq(schema.outbox.aggregateId, productId), eq(schema.outbox.eventType, eventType)))
      .orderBy(asc(schema.outbox.createdAt), asc(schema.outbox.id));

  const snapshotsOf = async (productId: string): Promise<CatalogSkuSnapshotPayload[]> =>
    (await eventsOf(productId, CATALOG_SKU_SNAPSHOT_EVENT)).map(({ payload }) => {
      if (!isCatalogSkuSnapshotPayload(payload)) throw new Error(`unusable snapshot of product ${productId}`);
      return payload;
    });

  const changedCountOf = async (productId: string): Promise<number> =>
    (await eventsOf(productId, PRODUCT_CHANGED_EVENT)).length;

  const latestSnapshotOf = async (productId: string): Promise<CatalogSkuSnapshotPayload | undefined> =>
    (await snapshotsOf(productId)).sort(byVersion).at(-1);

  const snapshotOf = (
    product: Pick<TestProduct, 'productId' | 'name'>,
    version: number,
    skus: SnapshotSku[],
  ): CatalogSkuSnapshotPayload => ({ productId: product.productId, version, productName: product.name, skus });

  async function expectOneSnapshot(expected: CatalogSkuSnapshotPayload): Promise<void> {
    const snapshots = await snapshotsOf(expected.productId);
    expect(snapshots).toHaveLength(1);
    expect(await changedCountOf(expected.productId)).toBe(1);
    expect(inSkuOrder(snapshots[0])).toEqual(inSkuOrder(expected));
  }

  describe('every write that changes a SKU view', () => {
    let product: TestProduct;

    beforeEach(async () => {
      product = await createTestProduct(app, { priceMinor: 199_000 });
    });

    it('appends a snapshot of a created product, at version 0 and with no SKUs', async () => {
      const { id: categoryId } = await createTestCategory(app);

      const res = await send('post', '/admin/products', {
        name: 'Snapshot Lamp',
        slug: `snapshot-lamp-${uniq()}`,
        categoryId,
        status: 'ACTIVE',
      }).expect(201);
      const productId = (res.body as { id: string }).id;

      await expectOneSnapshot(snapshotOf({ productId, name: 'Snapshot Lamp' }, 0, []));
    });

    // Each write's expected SKUs, given its response; the product starts at version 0 with one SKU.
    const writes: [string, () => request.Test, (res: request.Response) => SnapshotSku[], string?][] = [
      [
        'a rename',
        () => send('patch', `/admin/products/${product.productId}`, { name: 'Renamed shirt' }),
        () => [view(product.variantId, 199_000)],
        'Renamed shirt',
      ],
      [
        'a status change',
        () => send('patch', `/admin/products/${product.productId}`, { status: 'DRAFT' }),
        () => [view(product.variantId, 199_000, false)],
      ],
      [
        'an archive',
        () => send('delete', `/admin/products/${product.productId}`),
        () => [view(product.variantId, 199_000, false)],
      ],
      [
        'a SKU create',
        () => send('post', `/admin/products/${product.productId}/skus`, { sku: `SNAP-${uniq()}`, name: 'New size' }),
        (res) => [view(product.variantId, 199_000), view((res.body as { id: string }).id, null)],
      ],
      [
        'a SKU update',
        () => send('patch', `/admin/skus/${product.variantId}`, { name: 'Renamed size' }),
        () => [view(product.variantId, 199_000)],
      ],
      [
        'a SKU archive',
        () => send('delete', `/admin/skus/${product.variantId}`),
        () => [view(product.variantId, 199_000, false)],
      ],
      [
        'a price write',
        () => send('put', `/admin/skus/${product.variantId}/price`, { amountMinor: 250_000 }),
        () => [view(product.variantId, 250_000)],
      ],
      [
        'a price in another currency',
        () => send('put', `/admin/skus/${product.variantId}/price`, { amountMinor: 990, currency: 'USD' }),
        () => [view(product.variantId, 199_000)],
      ],
    ];

    it.each(writes)('appends one snapshot of the state %s leaves', async (_write, write, skusAfter, renamedTo) => {
      const res = await write();
      expect(res.status).toBeLessThan(300);

      await expectOneSnapshot(snapshotOf({ ...product, name: renamedTo ?? product.name }, 1, skusAfter(res)));
    });

    it('carries what the write changed', async () => {
      await send('put', `/admin/skus/${product.variantId}/price`, { amountMinor: 250_000 }).expect(200);
      expect((await latestSnapshotOf(product.productId))?.skus).toEqual([
        { skuId: product.variantId, unitPriceMinor: 250_000, currency: 'VND', isActive: true },
      ]);

      const created = await send('post', `/admin/products/${product.productId}/skus`, {
        sku: `SNAP-${uniq()}`,
        name: 'Unpriced size',
      }).expect(201);
      const unpricedId = (created.body as { id: string }).id;
      await send('delete', `/admin/skus/${product.variantId}`).expect(200);

      const latest = await latestSnapshotOf(product.productId);
      expect(latest?.version).toBe(3);
      expect(latest?.skus).toEqual(
        expect.arrayContaining([
          { skuId: product.variantId, unitPriceMinor: 250_000, currency: 'VND', isActive: false },
          { skuId: unpricedId, unitPriceMinor: null, currency: 'VND', isActive: true },
        ]),
      );
      expect(latest?.skus).toHaveLength(2);
    });

    it('appends none when the write fails', async () => {
      const other = await createTestProduct(app);

      await send('post', `/admin/products/${product.productId}/skus`, { sku: other.sku, name: 'Taken' }).expect(409);
      await send('patch', `/admin/skus/${product.variantId}`, { sku: other.sku }).expect(409);
      await send('patch', `/admin/skus/${testId()}`, { name: 'Nobody' }).expect(404);
      await send('put', `/admin/skus/${product.variantId}/price`, { amountMinor: 0 }).expect(400);

      expect(await snapshotsOf(product.productId)).toEqual([]);
      expect(await snapshotsOf(other.productId)).toEqual([]);
    });

    it('appends none for a category rename, which changes no SKU view', async () => {
      await send('patch', `/admin/categories/${product.categoryId}`, { name: `Renamed ${uniq()}` }).expect(200);

      expect(await snapshotsOf(product.productId)).toEqual([]);
      expect(await snapshotsOf(product.categoryId)).toEqual([]);
    });

    // Written before the floor existed, or by hand: it reads as unpriced rather than dead-lettering the product.
    it.each([0, -1])('publishes a stored price of %i as unpriced', async (amountMinor) => {
      await db.update(schema.prices).set({ amountMinor }).where(eq(schema.prices.variantId, product.variantId));

      await send('patch', `/admin/products/${product.productId}`, { name: 'Repriced by hand' }).expect(200);

      expect((await latestSnapshotOf(product.productId))?.skus).toEqual([
        { skuId: product.variantId, unitPriceMinor: null, currency: 'VND', isActive: true },
      ]);
    });

    it('orders concurrent writes on one product by version, the highest carrying every final price', async () => {
      const second = await send('post', `/admin/products/${product.productId}/skus`, {
        sku: `SNAP-${uniq()}`,
        name: 'Second size',
      }).expect(201);
      const skuIds = [product.variantId, (second.body as { id: string }).id];
      const before = (await snapshotsOf(product.productId)).length;

      const responses = await Promise.all(
        Array.from({ length: CONCURRENT_PRICE_WRITES }, (_, n) =>
          send('put', `/admin/skus/${skuIds[n % 2]}/price`, { amountMinor: 100_000 + n }),
        ),
      );
      expect(responses.map((res) => res.status)).toEqual(Array(CONCURRENT_PRICE_WRITES).fill(200));

      const burst = (await snapshotsOf(product.productId)).slice(before).sort(byVersion);
      expect(burst.map(({ version }) => version)).toEqual(
        Array.from({ length: CONCURRENT_PRICE_WRITES }, (_, n) => before + 1 + n),
      );
      // Which write of each SKU committed last is the race's to decide, so the final prices are read back.
      const finalPrices = new Map(
        (
          await db
            .select({ variantId: schema.prices.variantId, amountMinor: schema.prices.amountMinor })
            .from(schema.prices)
            .where(and(inArray(schema.prices.variantId, skuIds), eq(schema.prices.currency, 'VND')))
        ).map(({ variantId, amountMinor }) => [variantId, amountMinor]),
      );
      expect(inSkuOrder(burst.at(-1))).toEqual(
        inSkuOrder(
          snapshotOf(
            product,
            before + CONCURRENT_PRICE_WRITES,
            skuIds.map((skuId) => view(skuId, finalPrices.get(skuId) ?? null)),
          ),
        ),
      );
    });
  });

  describe('publishing the whole catalog', () => {
    const publishAll = (pageSize: number) =>
      publishSkuSnapshots(app.get(SkuSnapshotPublisher), app.get<IdGeneratorPort>(ID_GENERATOR), { pageSize });

    it('appends one snapshot per product at its current version, page by page, and can run again', async () => {
      const products = await Promise.all(Array.from({ length: 5 }, () => createTestProduct(app)));
      await send('put', `/admin/skus/${products[0].variantId}/price`, { amountMinor: 300_000 }).expect(200);
      await send('delete', `/admin/products/${products[1].productId}`).expect(200);

      await expect(publishAll(2)).resolves.toBe(products.length);

      expect(await latestSnapshotOf(products[0].productId)).toEqual(
        snapshotOf(products[0], 1, [view(products[0].variantId, 300_000)]),
      );
      expect(await latestSnapshotOf(products[1].productId)).toEqual(
        snapshotOf(products[1], 1, [view(products[1].variantId, 199_000, false)]),
      );
      for (const untouched of products.slice(2)) {
        expect(await latestSnapshotOf(untouched.productId)).toEqual(
          snapshotOf(untouched, 0, [view(untouched.variantId, 199_000)]),
        );
      }
      expect((await snapshotsOf(products[2].productId)).map(({ version }) => version)).toEqual([0]);

      await expect(publishAll(100)).resolves.toBe(products.length);
      expect((await snapshotsOf(products[2].productId)).map(({ version }) => version)).toEqual([0, 0]);
    });

    // The consumer keeps the highest version per product, so that is the snapshot that must be right.
    it('converges on the live state when writes land during the run', async () => {
      const products = await Promise.all(Array.from({ length: 6 }, () => createTestProduct(app)));

      await Promise.all([
        publishAll(1),
        ...products.map(({ variantId }, n) =>
          send('put', `/admin/skus/${variantId}/price`, { amountMinor: 400_000 + n }).expect(200),
        ),
      ]);

      for (const [n, written] of products.entries()) {
        expect(await latestSnapshotOf(written.productId)).toEqual(
          snapshotOf(written, 1, [view(written.variantId, 400_000 + n)]),
        );
      }
    });
  });
});
