import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import { authHeader } from '../setup/bearer.helper';
import { createTestAdminPrincipal } from '../setup/fixtures/principal.fixture';
import { createTestAppWithObjectStorage } from '../setup/harness';
import { startObjectStorage, type StartedObjectStorage } from '../setup/object-storage';
import { resetDatabase } from '../setup/reset-database';

// The lowest limit the env schema accepts.
const MAX_BYTES = 1024;

interface UploadTicket {
  assetId: string;
  uploadUrl: string;
  headers: Record<string, string>;
  expiresInSec: number;
}

// The v4 signature pins the content type but cannot cap the size, so the size limit is checked on
// confirm against what the bucket reports.
describe('Media upload handshake (integration, real MinIO + Postgres + Redis)', () => {
  let storage: StartedObjectStorage;
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;
  let adminToken: string;

  beforeAll(async () => {
    storage = await startObjectStorage();
    ({ app, pool, db } = await createTestAppWithObjectStorage(storage, { MEDIA_MAX_BYTES: String(MAX_BYTES) }));
  }, 180_000);

  // The app closes before the bucket it holds connections to.
  afterAll(async () => {
    await app?.close();
    await storage?.stop();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
    await storage.clear();
    adminToken = (await createTestAdminPrincipal(app)).accessToken;
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

  const confirm = (assetId: string): request.Test =>
    request(server()).post(`/admin/media/uploads/${assetId}/complete`).set(authHeader(adminToken));

  const assetRow = async (assetId: string) =>
    (await db.select().from(schema.mediaAssets).where(eq(schema.mediaAssets.id, assetId)))[0];

  it('hands out a signed URL and leaves an expiring PENDING row', async () => {
    const ticket = await ticketFor();

    const row = await assetRow(ticket.assetId);
    expect(row.status).toBe('PENDING');
    expect(row.storageKey).toBe(`media/${ticket.assetId}.png`);
    expect(row.expiresAt).not.toBeNull();
    expect(ticket.headers['Content-Type']).toBe('image/png');
    expect(ticket.expiresInSec).toBeGreaterThan(0);
  });

  it('completes the handshake: PUT to the bucket, then confirm', async () => {
    const ticket = await ticketFor();

    expect((await put(ticket, 'x'.repeat(100))).status).toBe(200);
    await confirm(ticket.assetId).expect(204);

    const row = await assetRow(ticket.assetId);
    expect(row.status).toBe('READY');
    expect(row.sizeBytes).toBe(100);
    expect(await storage.exists(row.storageKey)).toBe(true);
  });

  it('lets the bucket refuse a content type other than the one signed for', async () => {
    const ticket = await ticketFor('image/png');

    const res = await put(ticket, 'x', { 'Content-Type': 'text/html' });

    expect(res.status).toBe(403);
    expect(await storage.listKeys()).toEqual([]);
  });

  it('refuses to confirm an upload that never happened', async () => {
    const ticket = await ticketFor();

    await confirm(ticket.assetId).expect(409);

    expect((await assetRow(ticket.assetId)).status).toBe('PENDING');
  });

  // Left PENDING, so the sweep takes the oversized object too.
  it('rejects an object over the size limit on confirm', async () => {
    const ticket = await ticketFor();
    expect((await put(ticket, 'x'.repeat(MAX_BYTES + 1))).status).toBe(200);

    await confirm(ticket.assetId).expect(409);

    expect((await assetRow(ticket.assetId)).status).toBe('PENDING');
    expect(await storage.exists(`media/${ticket.assetId}.png`)).toBe(true);
  });

  it('answers 409 to a second confirm of the same upload', async () => {
    const ticket = await ticketFor();
    await put(ticket, 'x');
    await confirm(ticket.assetId).expect(204);

    await confirm(ticket.assetId).expect(409);
  });

  it('refuses to sign for a content type outside the image allow-list', async () => {
    const statuses: number[] = [];
    for (const contentType of ['image/svg+xml', 'text/html', 'application/pdf']) {
      const res = await request(server())
        .post('/admin/media/uploads')
        .set(authHeader(adminToken))
        .send({ contentType });
      statuses.push(res.status);
    }

    expect(statuses).toEqual([400, 400, 400]);
    expect(await db.select().from(schema.mediaAssets)).toEqual([]);
  });
});
