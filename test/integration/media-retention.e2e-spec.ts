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
import { RetentionSweepRegistry, type RetentionSweep } from '../../src/shared/retention';
import { createTestAdmin } from '../setup/fixtures/user.fixture';
import { createTestAppWithObjectStorage } from '../setup/harness';
import { E2E_METRICS_TOKEN, metricsAuthHeader } from '../setup/metrics.helper';
import { startObjectStorage, type StartedObjectStorage } from '../setup/object-storage';
import { resetDatabase } from '../setup/reset-database';

// The window after which a SWEEPING claim is assumed dead — the scheduler's own per-sweep timeout,
// since a claim older than that cannot still be in flight. One minute, so a claim stamped "now" and
// one stamped five minutes ago land either side of it regardless of how slow the runner is.
const SWEEP_TIMEOUT_MS = 60_000;
const MINUTE_MS = 60_000;
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * MINUTE_MS);
const minutesFromNow = (minutes: number) => new Date(Date.now() + minutes * MINUTE_MS);

/**
 * Reclaiming bytes cannot be undone, so these tests are about what the sweep must NOT take: anything
 * attached, not yet expired, or being claimed by another transaction. The order the sweep works in —
 * claim, then object, then row — is what makes an interrupted pass safe, and the crash cases say why.
 */
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
    if (!registered) throw new Error('media:assets is not registered — registration is what makes it run');
    sweep = registered;
  }, 180_000);

  // Explicit rather than `closeAppAfterAll`: the app has to go before the bucket it still holds
  // connections to.
  afterAll(async () => {
    await app?.close();
    await storage?.stop();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
    await storage.clear();
    // Assets carry the admin who uploaded them, and truncation takes the users with it.
    uploaderId = (await createTestAdmin(app)).user.id;
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

  it('reclaims an upload nobody ever confirmed', async () => {
    const asset = await seedAsset({ status: 'PENDING' });

    await expect(sweep.sweep(10)).resolves.toBe(1);

    expect(await statusOf(asset.id)).toBeUndefined();
    expect(await storage.exists(asset.storageKey)).toBe(false);
  });

  it('reclaims a READY asset that was uploaded and then never attached', async () => {
    const asset = await seedAsset({ status: 'READY' });

    await expect(sweep.sweep(10)).resolves.toBe(1);
    expect(await storage.exists(asset.storageKey)).toBe(false);
  });

  it('never touches an ATTACHED asset — it has no expiry, so it cannot be selected', async () => {
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

  it('refuses an attach that arrives after the claim — the bytes are already committed to deletion', async () => {
    const asset = await seedAsset({ status: 'SWEEPING' });

    await expect(db.transaction((tx) => facade.attach(tx, asset.id))).rejects.toBeInstanceOf(
      MediaAssetUnavailableError,
    );
    // SWEEPING is terminal: without that, a product could end up pointing at an object about to go.
    expect(await statusOf(asset.id)).toBe('SWEEPING');
  });

  it('loses to an attach that took the row lock first, even though the row was eligible when the pass began', async () => {
    // The ordering that actually costs bytes. The asset is eligible when the sweep's subquery selects
    // it, then the UPDATE blocks on the attach's lock. Postgres rechecks the statement's own WHERE
    // against the committed row but re-runs the subquery under the original snapshot, so a claim
    // matching on `id` alone would win here and delete an object a product just started pointing at.
    const asset = await seedAsset({ status: 'READY' });

    let releaseAttach!: () => void;
    const attachHolding = new Promise<void>((resolve) => (releaseAttach = resolve));
    const attach = db.transaction(async (tx) => {
      await facade.attach(tx, asset.id);
      await attachHolding;
    });

    // Long enough that the sweep's UPDATE is provably waiting on the lock, not racing to it.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const claimed = sweep.sweep(10);
    await new Promise((resolve) => setTimeout(resolve, 200));
    releaseAttach();
    await attach;

    await expect(claimed).resolves.toBe(0);
    expect(await statusOf(asset.id)).toBe('ATTACHED');
    expect(await storage.exists(asset.storageKey)).toBe(true);
  });

  it('finishes a pass that crashed between deleting the object and deleting the row', async () => {
    // Exactly the state a crash leaves: claimed, object already gone, row still there.
    const asset = await seedAsset({
      status: 'SWEEPING',
      updatedAt: minutesAgo(5),
      withObject: false,
    });

    // Deleting an absent object is a no-op, which is what makes the retry safe.
    await expect(sweep.sweep(10)).resolves.toBe(1);
    expect(await statusOf(asset.id)).toBeUndefined();
  });

  it('leaves a fresh claim alone — it may still be in flight', async () => {
    const asset = await seedAsset({ status: 'SWEEPING', updatedAt: new Date() });

    await expect(sweep.sweep(10)).resolves.toBe(0);
    expect(await statusOf(asset.id)).toBe('SWEEPING');
  });

  it('honours the batch size, so one pass cannot run unbounded', async () => {
    await seedAsset({ status: 'PENDING' });
    await seedAsset({ status: 'PENDING' });
    await seedAsset({ status: 'PENDING' });

    await expect(sweep.sweep(2)).resolves.toBe(2);
    expect(await db.select().from(schema.mediaAssets)).toHaveLength(1);
  });

  it('counts the bytes it gave back', async () => {
    // The counter is process-wide and every earlier case in this file has already added to it, so
    // the assertion is on the delta.
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
