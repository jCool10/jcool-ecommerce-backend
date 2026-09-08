import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DRIZZLE, PG_POOL, type DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import { authHeader } from '../setup/auth.helper';
import { createTestAdmin, createTestUser } from '../setup/fixtures/user.fixture';
import { startObjectStorage, type StartedObjectStorage } from '../setup/object-storage';
import { resetDatabase } from '../setup/reset-database';
import { createTestApp } from '../setup/test-app.factory';

// The env floor is 1024, and the point is a body that clears it — not a realistic image.
const MAX_BYTES = 1024;

interface UploadTicket {
  assetId: string;
  uploadUrl: string;
  headers: Record<string, string>;
  expiresInSec: number;
}

/**
 * The two-call upload handshake against a real S3-compatible bucket, because the guarantees under
 * test are the bucket's: what a v4 signature actually covers, and what it cannot.
 *
 * The signature pins the content type, so the bucket itself refuses a mismatched PUT — that is the
 * control. It cannot express a size ceiling (Content-Length is signed as one exact value), so the
 * limit is enforced on the way back, against what the bucket reports.
 */
describe('Media upload handshake (integration, real MinIO + Postgres + Redis)', () => {
  let storage: StartedObjectStorage;
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;
  let adminToken: string;

  beforeAll(async () => {
    storage = await startObjectStorage();
    app = await createTestApp({
      STORAGE_ENDPOINT: storage.endpoint,
      STORAGE_BUCKET: storage.bucket,
      STORAGE_ACCESS_KEY_ID: storage.accessKeyId,
      STORAGE_SECRET_ACCESS_KEY: storage.secretAccessKey,
      MEDIA_MAX_BYTES: String(MAX_BYTES),
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
    adminToken = (await createTestAdmin(app)).accessToken;
  });

  const server = () => app.getHttpServer();

  async function ticketFor(contentType = 'image/png'): Promise<UploadTicket> {
    const res = await request(server())
      .post('/admin/media/uploads')
      .set(authHeader(adminToken))
      .send({ contentType })
      .expect(201);
    return res.body as UploadTicket;
  }

  function put(ticket: UploadTicket, body: string, headers = ticket.headers): Promise<Response> {
    return fetch(ticket.uploadUrl, { method: 'PUT', headers, body });
  }

  const assetRow = async (assetId: string) =>
    (await db.select().from(schema.mediaAssets).where(eq(schema.mediaAssets.id, assetId)))[0];

  it('hands out a signed URL and leaves a PENDING row that a sweep could find', async () => {
    const ticket = await ticketFor();

    const row = await assetRow(ticket.assetId);
    expect(row.status).toBe('PENDING');
    expect(row.storageKey).toBe(`media/${ticket.assetId}.png`);
    // Never null outside ATTACHED: a row with no expiry can never be reclaimed.
    expect(row.expiresAt).not.toBeNull();
    expect(ticket.headers['Content-Type']).toBe('image/png');
    expect(ticket.expiresInSec).toBeGreaterThan(0);
  });

  it('completes the handshake: PUT to the bucket, then confirm', async () => {
    const ticket = await ticketFor();

    expect((await put(ticket, 'x'.repeat(100))).status).toBe(200);
    await request(server())
      .post(`/admin/media/uploads/${ticket.assetId}/complete`)
      .set(authHeader(adminToken))
      .expect(204);

    const row = await assetRow(ticket.assetId);
    expect(row.status).toBe('READY');
    // The size comes from the bucket, never from anything the client claimed.
    expect(row.sizeBytes).toBe(100);
    expect(await storage.exists(row.storageKey)).toBe(true);
  });

  it('lets the bucket refuse a content type other than the one signed for', async () => {
    const ticket = await ticketFor('image/png');

    const res = await put(ticket, 'x', { 'Content-Type': 'text/html' });

    // 403: the signature does not verify, so the object is never written.
    expect(res.status).toBe(403);
    expect(await storage.listKeys()).toEqual([]);
  });

  it('refuses to confirm an upload that never happened', async () => {
    const ticket = await ticketFor();

    await request(server())
      .post(`/admin/media/uploads/${ticket.assetId}/complete`)
      .set(authHeader(adminToken))
      .expect(409);

    // Still PENDING, so the sweep reclaims the row on its own.
    expect((await assetRow(ticket.assetId)).status).toBe('PENDING');
  });

  it('rejects an object over the size limit, which the signature could not have capped', async () => {
    const ticket = await ticketFor();
    expect((await put(ticket, 'x'.repeat(MAX_BYTES + 1))).status).toBe(200);

    await request(server())
      .post(`/admin/media/uploads/${ticket.assetId}/complete`)
      .set(authHeader(adminToken))
      .expect(409);

    // Left behind on purpose: the row is still PENDING, so the sweep takes the oversized object too.
    expect((await assetRow(ticket.assetId)).status).toBe('PENDING');
    expect(await storage.exists(`media/${ticket.assetId}.png`)).toBe(true);
  });

  it('is idempotent only once — a second confirm finds the asset already moved on', async () => {
    const ticket = await ticketFor();
    await put(ticket, 'x');
    await request(server())
      .post(`/admin/media/uploads/${ticket.assetId}/complete`)
      .set(authHeader(adminToken))
      .expect(204);

    await request(server())
      .post(`/admin/media/uploads/${ticket.assetId}/complete`)
      .set(authHeader(adminToken))
      .expect(409);
  });

  it('404s a confirm for an asset that does not exist', async () => {
    await request(server())
      .post('/admin/media/uploads/00000000-0000-4000-8000-000000000000/complete')
      .set(authHeader(adminToken))
      .expect(404);
  });

  it.each(['image/svg+xml', 'text/html', 'application/pdf'])('refuses to sign for %s', async (contentType) => {
    await request(server()).post('/admin/media/uploads').set(authHeader(adminToken)).send({ contentType }).expect(400);

    expect(await db.select().from(schema.mediaAssets)).toEqual([]);
  });

  it('is admin-only — anyone who can sign can write to the bucket', async () => {
    const buyer = await createTestUser(app);

    await request(server())
      .post('/admin/media/uploads')
      .set(authHeader(buyer.accessToken))
      .send({ contentType: 'image/png' })
      .expect(403);
  });
});
