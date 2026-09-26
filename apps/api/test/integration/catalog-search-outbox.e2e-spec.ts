import type { INestApplication } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import { authHeader } from '../setup/bearer.helper';
import { createTestCategory, createTestProduct, type TestProduct } from '../setup/fixtures/catalog.fixture';
import { createTestAdminPrincipal, type TestPrincipal } from '../setup/fixtures/principal.fixture';
import { closeAppAfterAll, createTestAppWithPool, resetDatabaseBeforeEach } from '../setup/harness';

const ABSENT_UUID = '0197c8f4-3a1b-7c2d-8e4f-1a2b3c4d5e6f';
const RACE_ROUNDS = 5;

const PRODUCT_CHANGED = { aggregateType: 'Product', eventType: 'catalog.product.changed', payload: {} };
const CATEGORY_RENAMED = { aggregateType: 'Category', eventType: 'catalog.category.renamed', payload: {} };

let seq = 0;
const uniq = (): string => `${Date.now()}-${seq++}`;

describe('Catalog search outbox emission (integration, real Postgres)', () => {
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

  const eventsFor = (aggregateId: string) =>
    db
      .select({
        aggregateType: schema.outbox.aggregateType,
        eventType: schema.outbox.eventType,
        payload: schema.outbox.payload,
      })
      .from(schema.outbox)
      .where(eq(schema.outbox.aggregateId, aggregateId))
      .orderBy(asc(schema.outbox.createdAt), asc(schema.outbox.id));

  async function versionOf(productId: string): Promise<number> {
    const [row] = await db
      .select({ version: schema.products.searchVersion })
      .from(schema.products)
      .where(eq(schema.products.id, productId));
    return row.version;
  }

  async function trail(productId: string): Promise<{ events: number; version: number }> {
    return { events: (await eventsFor(productId)).length, version: await versionOf(productId) };
  }

  describe('product writes', () => {
    it('appends one change event at version 0 when a product is created', async () => {
      const { id: categoryId } = await createTestCategory(app);

      const res = await send('post', '/admin/products', {
        name: 'Outbox Lamp',
        slug: `outbox-lamp-${uniq()}`,
        categoryId,
        status: 'ACTIVE',
      }).expect(201);
      const productId = (res.body as { id: string }).id;

      expect(await eventsFor(productId)).toEqual([PRODUCT_CHANGED]);
      expect(await versionOf(productId)).toBe(0);
    });

    it('bumps the version and appends once per product update', async () => {
      const product = await createTestProduct(app);

      await send('patch', `/admin/products/${product.productId}`, { name: 'Renamed once' }).expect(200);
      expect(await trail(product.productId)).toEqual({ events: 1, version: 1 });

      await send('patch', `/admin/products/${product.productId}`, { description: 'Updated copy' }).expect(200);
      expect(await trail(product.productId)).toEqual({ events: 2, version: 2 });
      expect(await eventsFor(product.productId)).toEqual([PRODUCT_CHANGED, PRODUCT_CHANGED]);
    });

    it('appends nothing for an empty update patch', async () => {
      const product = await createTestProduct(app);
      await send('patch', `/admin/products/${product.productId}`, { name: 'Real change' }).expect(200);
      expect(await trail(product.productId)).toEqual({ events: 1, version: 1 });

      await send('patch', `/admin/products/${product.productId}`, {}).expect(200);

      expect(await trail(product.productId)).toEqual({ events: 1, version: 1 });
    });

    it('rolls back the bump and the event when an update hits a slug conflict', async () => {
      const taken = await createTestProduct(app);
      const product = await createTestProduct(app);
      await send('patch', `/admin/products/${product.productId}`, { name: 'Before conflict' }).expect(200);
      expect(await trail(product.productId)).toEqual({ events: 1, version: 1 });

      await send('patch', `/admin/products/${product.productId}`, { slug: taken.slug }).expect(409);

      expect(await trail(product.productId)).toEqual({ events: 1, version: 1 });
    });

    it('bumps the version and appends once when a product is archived', async () => {
      const product = await createTestProduct(app);

      await send('delete', `/admin/products/${product.productId}`).expect(200);

      expect(await eventsFor(product.productId)).toEqual([PRODUCT_CHANGED]);
      expect(await versionOf(product.productId)).toBe(1);
    });
  });

  describe('SKU and price writes', () => {
    let product: TestProduct;

    beforeEach(async () => {
      product = await createTestProduct(app);
    });

    it('appends one event on the parent product for each SKU create, update and archive', async () => {
      const created = await send('post', `/admin/products/${product.productId}/skus`, {
        sku: `OUTBOX-${uniq()}`,
        name: 'Outbox variant',
      }).expect(201);
      const skuId = (created.body as { id: string }).id;
      expect(await trail(product.productId)).toEqual({ events: 1, version: 1 });

      await send('patch', `/admin/skus/${skuId}`, { name: 'Outbox variant, renamed' }).expect(200);
      expect(await trail(product.productId)).toEqual({ events: 2, version: 2 });

      await send('delete', `/admin/skus/${skuId}`).expect(200);
      expect(await trail(product.productId)).toEqual({ events: 3, version: 3 });

      expect(await eventsFor(skuId)).toEqual([]);
    });

    it('appends nothing when an unknown SKU is updated or archived', async () => {
      await send('patch', `/admin/skus/${product.variantId}`, { name: 'Known variant' }).expect(200);
      expect(await db.select().from(schema.outbox)).toHaveLength(1);

      await send('patch', `/admin/skus/${ABSENT_UUID}`, { name: 'Nobody' }).expect(404);
      await send('delete', `/admin/skus/${ABSENT_UUID}`).expect(404);

      expect(await db.select().from(schema.outbox)).toHaveLength(1);
      expect(await trail(product.productId)).toEqual({ events: 1, version: 1 });
    });

    it('rolls back the bump and the event when a SKU update hits a code conflict', async () => {
      const other = await createTestProduct(app);
      await send('patch', `/admin/skus/${product.variantId}`, { name: 'Before conflict' }).expect(200);
      expect(await trail(product.productId)).toEqual({ events: 1, version: 1 });

      await send('patch', `/admin/skus/${product.variantId}`, { sku: other.sku }).expect(409);

      expect(await trail(product.productId)).toEqual({ events: 1, version: 1 });
    });

    it('appends one event on the parent product when a price is set', async () => {
      await send('put', `/admin/skus/${product.variantId}/price`, { amountMinor: 250_000 }).expect(200);

      expect(await eventsFor(product.productId)).toEqual([PRODUCT_CHANGED]);
      expect(await versionOf(product.productId)).toBe(1);
      expect(await eventsFor(product.variantId)).toEqual([]);
    });

    // The SKU code change locks the variant FOR UPDATE and the new-currency price insert key-shares
    // it, so either write taking the product lock after its child row deadlocks against the other.
    // One race hits that interleaving about half the time, hence the rounds.
    it('commits concurrent product, SKU and price writes on one product with one event each', async () => {
      for (let round = 0; round < RACE_ROUNDS; round += 1) {
        const target = round === 0 ? product : await createTestProduct(app);

        const responses = await Promise.all([
          send('patch', `/admin/products/${target.productId}`, { name: `Racing rename ${round}` }),
          send('patch', `/admin/skus/${target.variantId}`, { sku: `RACE-CODE-${uniq()}` }),
          send('put', `/admin/skus/${target.variantId}/price`, { amountMinor: 310, currency: 'USD' }),
          send('post', `/admin/products/${target.productId}/skus`, { sku: `RACE-${uniq()}`, name: 'Racing variant' }),
        ]);

        expect(responses.map((res) => res.status)).toEqual([200, 200, 200, 201]);
        expect(await trail(target.productId)).toEqual({ events: 4, version: 4 });
      }
    });
  });

  describe('category writes', () => {
    let categoryId: string;
    let product: TestProduct;

    beforeEach(async () => {
      categoryId = (await createTestCategory(app)).id;
      product = await createTestProduct(app, { categoryId });
    });

    it('appends one rename event per real name or slug change and none for its products', async () => {
      await send('patch', `/admin/categories/${categoryId}`, { name: `Renamed ${uniq()}` }).expect(200);
      await send('patch', `/admin/categories/${categoryId}`, { slug: `renamed-${uniq()}` }).expect(200);

      expect(await eventsFor(categoryId)).toEqual([CATEGORY_RENAMED, CATEGORY_RENAMED]);
      expect(await trail(product.productId)).toEqual({ events: 0, version: 0 });
    });

    it('appends nothing when an update resends the current name and slug', async () => {
      const renamed = await send('patch', `/admin/categories/${categoryId}`, {
        name: `Renamed ${uniq()}`,
        slug: `renamed-${uniq()}`,
      }).expect(200);
      expect(await eventsFor(categoryId)).toEqual([CATEGORY_RENAMED]);
      const { name, slug } = renamed.body as { name: string; slug: string };

      await send('patch', `/admin/categories/${categoryId}`, { name, slug }).expect(200);

      expect(await eventsFor(categoryId)).toEqual([CATEGORY_RENAMED]);
    });

    it('appends nothing when only the parent moves', async () => {
      const parent = await createTestCategory(app);
      await send('patch', `/admin/categories/${categoryId}`, { name: `Renamed ${uniq()}` }).expect(200);
      expect(await eventsFor(categoryId)).toEqual([CATEGORY_RENAMED]);

      const moved = await send('patch', `/admin/categories/${categoryId}`, { parentId: parent.id }).expect(200);

      expect((moved.body as { parentId: string }).parentId).toBe(parent.id);
      expect(await eventsFor(categoryId)).toEqual([CATEGORY_RENAMED]);
    });
  });

  describe('image writes', () => {
    async function seedReadyAsset(): Promise<string> {
      const [row] = await db
        .insert(schema.mediaAssets)
        .values({
          storageKey: `media/${crypto.randomUUID()}.png`,
          contentType: 'image/png',
          sizeBytes: 100,
          status: 'READY',
          uploadedBy: admin.user.id,
          expiresAt: new Date(Date.now() + 3_600_000),
        })
        .returning();
      return row.id;
    }

    it('appends nothing for image attach, reorder and detach', async () => {
      const product = await createTestProduct(app);
      await send('put', `/admin/skus/${product.variantId}/price`, { amountMinor: 120_000 }).expect(200);
      expect(await trail(product.productId)).toEqual({ events: 1, version: 1 });

      const images: string[] = [];
      for (const assetId of [await seedReadyAsset(), await seedReadyAsset()]) {
        const res = await send('post', `/admin/products/${product.productId}/images`, { assetId }).expect(201);
        images.push((res.body as { id: string }).id);
      }
      await send('patch', `/admin/products/${product.productId}/images`, {
        imageIds: [...images].reverse(),
      }).expect(200);
      await send('delete', `/admin/products/${product.productId}/images/${images[0]}`).expect(204);

      expect(await trail(product.productId)).toEqual({ events: 1, version: 1 });
      expect(await db.select().from(schema.outbox)).toHaveLength(1);
    });
  });
});
