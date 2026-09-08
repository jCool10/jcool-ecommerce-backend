import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DRIZZLE, PG_POOL, type DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import { authHeader } from '../setup/auth.helper';
import { createTestProduct, type TestProduct } from '../setup/fixtures/catalog.fixture';
import { createTestAdmin } from '../setup/fixtures/user.fixture';
import { startObjectStorage, type StartedObjectStorage } from '../setup/object-storage';
import { resetCatalogCache } from '../setup/reset-cache';
import { resetDatabase } from '../setup/reset-database';
import { createTestApp } from '../setup/test-app.factory';

const ABSENT_UUID = '00000000-0000-4000-8000-000000000000';

/**
 * Product images across the Catalog↔Media boundary. Catalog stores asset ids and nothing else — the
 * URL is resolved on the way out, after the cache, which is what lets a short-lived signed URL be
 * served from a long-lived cached product.
 *
 * The state machine is the other half: an asset may be attached exactly once, and only from READY.
 */
describe('Product images (integration, real MinIO + Postgres + Redis)', () => {
  let storage: StartedObjectStorage;
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;
  let adminToken: string;
  let product: TestProduct;

  beforeAll(async () => {
    storage = await startObjectStorage();
    app = await createTestApp({
      STORAGE_ENDPOINT: storage.endpoint,
      STORAGE_BUCKET: storage.bucket,
      STORAGE_ACCESS_KEY_ID: storage.accessKeyId,
      STORAGE_SECRET_ACCESS_KEY: storage.secretAccessKey,
    });
    pool = app.get<Pool>(PG_POOL);
    db = app.get<DrizzleDB>(DRIZZLE);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await storage?.stop();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
    await storage.clear();
    await resetCatalogCache(app);
    adminToken = (await createTestAdmin(app)).accessToken;
    product = await createTestProduct(app);
  });

  const server = () => app.getHttpServer();

  /** An asset in whatever state the test needs, with its object actually in the bucket. */
  async function seedAsset(status: 'PENDING' | 'READY' | 'ATTACHED' = 'READY'): Promise<string> {
    const uploader = (await createTestAdmin(app)).user.id;
    const [row] = await db
      .insert(schema.mediaAssets)
      .values({
        storageKey: `media/${crypto.randomUUID()}.png`,
        contentType: 'image/png',
        sizeBytes: 100,
        status,
        uploadedBy: uploader,
        expiresAt: status === 'ATTACHED' ? null : new Date(Date.now() + 3_600_000),
      })
      .returning();
    await storage.put(row.storageKey, 'x'.repeat(100), 'image/png');
    return row.id;
  }

  const attach = (assetId: string, body: Record<string, unknown> = {}): request.Test =>
    request(server())
      .post(`/admin/products/${product.productId}/images`)
      .set(authHeader(adminToken))
      .send({ assetId, ...body });

  const detail = (): request.Test => request(server()).get(`/products/${product.productId}`);

  const assetStatus = async (assetId: string): Promise<string | undefined> =>
    (await db.select().from(schema.mediaAssets).where(eq(schema.mediaAssets.id, assetId)))[0]?.status;

  it('attaches a READY asset and serves it on the public detail', async () => {
    const assetId = await seedAsset();

    const created = await attach(assetId).expect(201);
    expect(created.body.assetId).toBe(assetId);
    expect(created.body.position).toBe(0);
    expect(await assetStatus(assetId)).toBe('ATTACHED');

    const res = await detail().expect(200);
    expect(res.body.images).toHaveLength(1);
    expect(res.body.images[0].assetId).toBe(assetId);
    // A URL, resolved now — the id is what was stored.
    expect(res.body.images[0].url).toContain(storage.bucket);
  });

  it('clears the expiry on attach, so the sweep can never take an image off a live product', async () => {
    const assetId = await seedAsset();
    await attach(assetId).expect(201);

    const [row] = await db.select().from(schema.mediaAssets).where(eq(schema.mediaAssets.id, assetId));
    expect(row.expiresAt).toBeNull();
  });

  it('refuses an asset whose upload was never confirmed', async () => {
    const assetId = await seedAsset('PENDING');

    await attach(assetId).expect(409);

    expect(await assetStatus(assetId)).toBe('PENDING');
    expect((await detail().expect(200)).body.images).toEqual([]);
  });

  it('refuses an asset that is already attached somewhere', async () => {
    const assetId = await seedAsset('ATTACHED');

    await attach(assetId).expect(409);
  });

  it('rolls the link row back when the claim fails — no half-attached image', async () => {
    const assetId = await seedAsset('PENDING');

    await attach(assetId).expect(409);

    expect(await db.select().from(schema.productImages)).toEqual([]);
  });

  it('refuses the same asset twice on one product', async () => {
    const assetId = await seedAsset();
    await attach(assetId).expect(201);

    await attach(assetId).expect(409);
  });

  it('404s an attach to a product that does not exist', async () => {
    const assetId = await seedAsset();

    await request(server())
      .post(`/admin/products/${ABSENT_UUID}/images`)
      .set(authHeader(adminToken))
      .send({ assetId })
      .expect(404);
  });

  it('appends each new image after the last', async () => {
    const first = await seedAsset();
    const second = await seedAsset();

    expect((await attach(first).expect(201)).body.position).toBe(0);
    expect((await attach(second).expect(201)).body.position).toBe(1);

    const res = await detail().expect(200);
    expect(res.body.images.map((image: { assetId: string }) => image.assetId)).toEqual([first, second]);
  });

  it('detaches an image and hands the asset back to the sweep', async () => {
    const assetId = await seedAsset();
    const imageId = (await attach(assetId).expect(201)).body.id as string;

    await request(server())
      .delete(`/admin/products/${product.productId}/images/${imageId}`)
      .set(authHeader(adminToken))
      .expect(204);

    expect(await assetStatus(assetId)).toBe('DETACHED');
    // The bytes stay until a sweep takes them — detaching is not a delete.
    const [row] = await db.select().from(schema.mediaAssets).where(eq(schema.mediaAssets.id, assetId));
    expect(row.expiresAt).not.toBeNull();
    expect(await storage.exists(row.storageKey)).toBe(true);
    expect((await detail().expect(200)).body.images).toEqual([]);
  });

  it('404s a detach for an image that is not on that product', async () => {
    await request(server())
      .delete(`/admin/products/${product.productId}/images/${ABSENT_UUID}`)
      .set(authHeader(adminToken))
      .expect(404);
  });

  it('reorders the whole set at once', async () => {
    const first = (await attach(await seedAsset()).expect(201)).body.id as string;
    const second = (await attach(await seedAsset()).expect(201)).body.id as string;

    const res = await request(server())
      .patch(`/admin/products/${product.productId}/images`)
      .set(authHeader(adminToken))
      .send({ imageIds: [second, first] })
      .expect(200);

    expect(res.body.map((image: { id: string }) => image.id)).toEqual([second, first]);

    const publicImages = (await detail().expect(200)).body.images as { assetId: string }[];
    expect(publicImages).toHaveLength(2);
  });

  it('refuses a partial order rather than half-applying it', async () => {
    const first = (await attach(await seedAsset()).expect(201)).body.id as string;
    await attach(await seedAsset()).expect(201);

    await request(server())
      .patch(`/admin/products/${product.productId}/images`)
      .set(authHeader(adminToken))
      .send({ imageIds: [first] })
      .expect(409);
  });

  it('refuses an order naming an image from another product', async () => {
    const mine = (await attach(await seedAsset()).expect(201)).body.id as string;

    await request(server())
      .patch(`/admin/products/${product.productId}/images`)
      .set(authHeader(adminToken))
      .send({ imageIds: [mine, ABSENT_UUID] })
      .expect(409);
  });

  it('invalidates the cached product, so an attach is visible on the next read', async () => {
    // Warm the cache with the image-less product first — the whole point of the generation bump.
    expect((await detail().expect(200)).body.images).toEqual([]);

    const assetId = await seedAsset();
    await attach(assetId).expect(201);

    const res = await detail().expect(200);
    expect(res.body.images.map((image: { assetId: string }) => image.assetId)).toEqual([assetId]);
  });

  it('lists a product with no images as an empty array, not a missing field', async () => {
    const res = await detail().expect(200);

    expect(res.body.images).toEqual([]);
  });

  it('carries images through the list endpoint too', async () => {
    const assetId = await seedAsset();
    await attach(assetId).expect(201);

    const res = await request(server()).get('/products').expect(200);

    const listed = (res.body.items as { id: string; images: { assetId: string }[] }[]).find(
      (item) => item.id === product.productId,
    );
    expect(listed?.images.map((image) => image.assetId)).toEqual([assetId]);
  });
});
