import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  MEDIA_FACADE,
  MediaAssetUnavailableError,
  type MediaFacade,
} from '../../src/modules/media/application/public/media-facade.port';
import type { DrizzleDB } from '../../src/shared/infrastructure/database/drizzle.tokens';
import * as schema from '../../src/shared/infrastructure/database/schema';
import { RetentionSweepRegistry, type RetentionSweep } from '@jcool/platform/retention';
import { releaseOnceBlocked } from '../setup/fixtures/inventory.fixture';
import { createTestAdminPrincipal } from '../setup/fixtures/principal.fixture';
import { createTestAppWithObjectStorage } from '../setup/harness';
import { E2E_METRICS_TOKEN, metricsAuthHeader } from '../setup/metrics.helper';
import { startObjectStorage, type StartedObjectStorage } from '../setup/object-storage';
import { resetDatabase } from '../setup/reset-database';

// A SWEEPING claim older than the per-sweep timeout is assumed dead.
const SWEEP_TIMEOUT_MS = 60_000;
const MINUTE_MS = 60_000;
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * MINUTE_MS);
const minutesFromNow = (minutes: number) => new Date(Date.now() + minutes * MINUTE_MS);

describe('Media retention sweep (integration, real MinIO + Postgres)', () => {
  let storage: StartedObjectStorage;
  let app: INestApplication;
  let pool: Pool;
  let db: DrizzleDB;
  let sweep: RetentionSweep;
  let facade: MediaFacade;
  let uploaderId: string;

  beforeAll(async () => {
    storage = await startObjectStorage();
    ({ app, pool, db } = await createTestAppWithObjectStorage(storage, {
      RETENTION_SWEEP_TIMEOUT_MS: String(SWEEP_TIMEOUT_MS),
      METRICS_TOKEN: E2E_METRICS_TOKEN,
    }));
    facade = app.get<MediaFacade>(MEDIA_FACADE);

    const registered = app
      .get(RetentionSweepRegistry)
      .all()
      .find((candidate) => candidate.name === 'media:assets');
    if (!registered) throw new Error('media:assets is not registered, so it never runs');
    sweep = registered;
  }, 180_000);

  // The app closes before the bucket it holds connections to.
  afterAll(async () => {
    await app?.close();
    await storage?.stop();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
    await storage.clear();
    uploaderId = (await createTestAdminPrincipal(app)).user.id;
  });

  async function seedAsset(overrides: {
    status: 'PENDING' | 'READY' | 'ATTACHED' | 'DETACHED' | 'SWEEPING';
    expiresAt?: Date | null;
    updatedAt?: Date;
    sizeBytes?: number | null;
    withObject?: boolean;
  }): Promise<{ id: string; storageKey: string }> {
    const [row] = await db
      .insert(schema.mediaAssets)
      .values({
        storageKey: `media/${crypto.randomUUID()}.png`,
        contentType: 'image/png',
        sizeBytes: overrides.sizeBytes ?? 100,
        status: overrides.status,
        uploadedBy: uploaderId,
        expiresAt: overrides.expiresAt === undefined ? minutesAgo(5) : overrides.expiresAt,
        ...(overrides.updatedAt ? { updatedAt: overrides.updatedAt } : {}),
      })
      .returning();
    if (overrides.withObject !== false) {
      await storage.put(row.storageKey, 'x'.repeat(100), 'image/png');
    }
    return { id: row.id, storageKey: row.storageKey };
  }

  const statusOf = async (id: string): Promise<string | undefined> =>
    (await db.select().from(schema.mediaAssets).where(eq(schema.mediaAssets.id, id)))[0]?.status;

  it('reclaims an expired upload whether or not it was confirmed', async () => {
    const pending = await seedAsset({ status: 'PENDING' });
    const ready = await seedAsset({ status: 'READY' });

    await expect(sweep.sweep(10)).resolves.toBe(2);

    expect(await statusOf(pending.id)).toBeUndefined();
    expect(await statusOf(ready.id)).toBeUndefined();
    expect(await storage.exists(pending.storageKey)).toBe(false);
    expect(await storage.exists(ready.storageKey)).toBe(false);
  });

  it('never touches an ATTACHED asset', async () => {
    const asset = await seedAsset({ status: 'ATTACHED', expiresAt: null });

    await expect(sweep.sweep(10)).resolves.toBe(0);

    expect(await statusOf(asset.id)).toBe('ATTACHED');
    expect(await storage.exists(asset.storageKey)).toBe(true);
  });

  it('leaves an asset whose expiry has not passed', async () => {
    const asset = await seedAsset({ status: 'READY', expiresAt: minutesFromNow(30) });

    await expect(sweep.sweep(10)).resolves.toBe(0);
    expect(await storage.exists(asset.storageKey)).toBe(true);
  });

  it('refuses an attach that arrives after the claim', async () => {
    const asset = await seedAsset({ status: 'SWEEPING' });

    await expect(db.transaction((tx) => facade.attach(tx, asset.id))).rejects.toBeInstanceOf(
      MediaAssetUnavailableError,
    );
    expect(await statusOf(asset.id)).toBe('SWEEPING');
  });

  // The claim's subquery keeps its first snapshot, so only the recheck of its own WHERE after the
  // lock clears keeps it off an asset the attach just committed.
  it('loses to an attach that took the row lock first', async () => {
    const asset = await seedAsset({ status: 'READY' });

    let releaseAttach!: () => void;
    const attachMayCommit = new Promise<void>((resolve) => (releaseAttach = resolve));
    let attachHasLocked!: () => void;
    const attachLocked = new Promise<void>((resolve) => (attachHasLocked = resolve));
    const attach = db.transaction(async (tx) => {
      await facade.attach(tx, asset.id);
      attachHasLocked();
      await attachMayCommit;
    });
    await attachLocked;

    const claimed = sweep.sweep(10);
    claimed.catch(() => {});
    await releaseOnceBlocked(pool, releaseAttach, { subject: 'the sweep claim' });
    await attach;

    await expect(claimed).resolves.toBe(0);
    expect(await statusOf(asset.id)).toBe('ATTACHED');
    expect(await storage.exists(asset.storageKey)).toBe(true);
  });

  it('finishes a pass that crashed between deleting the object and deleting the row', async () => {
    const asset = await seedAsset({
      status: 'SWEEPING',
      updatedAt: minutesAgo(5),
      withObject: false,
    });

    await expect(sweep.sweep(10)).resolves.toBe(1);
    expect(await statusOf(asset.id)).toBeUndefined();
  });

  it('leaves a fresh claim alone', async () => {
    const asset = await seedAsset({ status: 'SWEEPING', updatedAt: new Date() });

    await expect(sweep.sweep(10)).resolves.toBe(0);
    expect(await statusOf(asset.id)).toBe('SWEEPING');
  });

  it('honours the batch size', async () => {
    await seedAsset({ status: 'PENDING' });
    await seedAsset({ status: 'PENDING' });
    await seedAsset({ status: 'PENDING' });

    await expect(sweep.sweep(2)).resolves.toBe(2);
    expect(await db.select().from(schema.mediaAssets)).toHaveLength(1);
  });

  it('counts the bytes it gave back', async () => {
    const before = await reclaimedBytes();
    await seedAsset({ status: 'PENDING', sizeBytes: 400 });
    await sweep.sweep(10);

    expect(await reclaimedBytes()).toBe(before + 400);
  });

  async function reclaimedBytes(): Promise<number> {
    const { text } = await request(app.getHttpServer()).get('/metrics').set(metricsAuthHeader()).expect(200);
    const match = /^media_bytes_reclaimed_total (\d+(?:\.\d+)?)$/m.exec(text);
    if (!match) throw new Error('media_bytes_reclaimed_total is not exported');
    return Number(match[1]);
  }
});
