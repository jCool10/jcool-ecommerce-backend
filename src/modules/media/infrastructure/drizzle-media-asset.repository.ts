import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, lt, or } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB, type DrizzleTx } from '@shared/infrastructure/database';
import type { AllowedContentType } from '../domain/asset-content-type';
import { assertTransition } from '../domain/asset-state-machine';
import { AssetStatus, RECLAIMABLE_STATUSES } from '../domain/asset-status';
import { MediaAssetNotFoundError } from '../domain/errors/media-asset-not-found.error';
import { MediaAsset } from '../domain/media-asset.entity';
import type { ClaimedAsset, MediaAssetRepositoryPort } from '../application/ports/media-asset-repository.port';
import { mediaAssets } from './schema/media.schema';

@Injectable()
export class DrizzleMediaAssetRepository implements MediaAssetRepositoryPort {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  async insertPending(asset: MediaAsset): Promise<void> {
    await this.db.insert(mediaAssets).values({
      id: asset.id,
      storageKey: asset.storageKey,
      contentType: asset.contentType,
      status: asset.status,
      uploadedBy: asset.uploadedBy,
      expiresAt: asset.expiresAt,
    });
  }

  async findById(id: string): Promise<MediaAsset | null> {
    const [row] = await this.db.select().from(mediaAssets).where(eq(mediaAssets.id, id));
    return row ? toEntity(row) : null;
  }

  async markReady(id: string, sizeBytes: number, expiresAt: Date): Promise<boolean> {
    // The status predicate is the concurrency control: a sweep that claimed this row between the
    // read and this write leaves it at SWEEPING, and this matches nothing.
    const rows = await this.db
      .update(mediaAssets)
      .set({ status: AssetStatus.READY, sizeBytes, expiresAt })
      .where(and(eq(mediaAssets.id, id), eq(mediaAssets.status, AssetStatus.PENDING)))
      .returning({ id: mediaAssets.id });
    return rows.length > 0;
  }

  async claimForSweep(now: Date, staleClaimBefore: Date, limit: number): Promise<ClaimedAsset[]> {
    const eligible = or(
      and(inArray(mediaAssets.status, [...RECLAIMABLE_STATUSES]), lt(mediaAssets.expiresAt, now)),
      // A claim this old belongs to a pass that was interrupted between deleting the object and
      // deleting the row. Picking it up again is safe: deleting an absent object is a no-op.
      and(eq(mediaAssets.status, AssetStatus.SWEEPING), lt(mediaAssets.updatedAt, staleClaimBefore)),
    );

    // Repeating `eligible` on the UPDATE itself is load-bearing. Under READ COMMITTED an UPDATE that
    // blocks on a concurrent writer rechecks its own WHERE against the row the winner committed —
    // but the subquery keeps the statement's original snapshot, so `id IN (…)` alone would still
    // match an attach that just committed and delete its bytes out from under the product. It also
    // re-reads `expires_at`: an upload confirmed while this statement waited is READY — still a
    // reclaimable status — and only its extended expiry keeps it out of the claim.
    return this.db
      .update(mediaAssets)
      .set({ status: AssetStatus.SWEEPING, updatedAt: new Date() })
      .where(
        and(
          inArray(
            mediaAssets.id,
            this.db.select({ id: mediaAssets.id }).from(mediaAssets).where(eligible).limit(limit),
          ),
          eligible,
        ),
      )
      .returning({ id: mediaAssets.id, storageKey: mediaAssets.storageKey, sizeBytes: mediaAssets.sizeBytes });
  }

  async deleteClaimed(id: string): Promise<boolean> {
    const rows = await this.db
      .delete(mediaAssets)
      .where(and(eq(mediaAssets.id, id), eq(mediaAssets.status, AssetStatus.SWEEPING)))
      .returning({ id: mediaAssets.id });
    return rows.length > 0;
  }

  async attach(tx: DrizzleTx, id: string): Promise<void> {
    const status = await this.lockStatus(tx, id);
    assertTransition(status, AssetStatus.ATTACHED);
    // The only place an expiry is cleared; every other state must stay selectable by the sweep.
    await tx.update(mediaAssets).set({ status: AssetStatus.ATTACHED, expiresAt: null }).where(eq(mediaAssets.id, id));
  }

  async detach(tx: DrizzleTx, id: string, expiresAt: Date): Promise<void> {
    const status = await this.lockStatus(tx, id);
    assertTransition(status, AssetStatus.DETACHED);
    await tx.update(mediaAssets).set({ status: AssetStatus.DETACHED, expiresAt }).where(eq(mediaAssets.id, id));
  }

  findStorageKeys(ids: string[]): Promise<{ id: string; storageKey: string }[]> {
    return this.db
      .select({ id: mediaAssets.id, storageKey: mediaAssets.storageKey })
      .from(mediaAssets)
      .where(inArray(mediaAssets.id, ids));
  }

  /**
   * Reads the status under a row lock, so the check and the write that follows cannot be split by a
   * sweep claim: the claim either waits here and then sees the new status, or wins and leaves a
   * status the transition rejects.
   */
  private async lockStatus(tx: DrizzleTx, id: string): Promise<AssetStatus> {
    const [row] = await tx
      .select({ status: mediaAssets.status })
      .from(mediaAssets)
      .where(eq(mediaAssets.id, id))
      .for('update');
    if (!row) throw new MediaAssetNotFoundError(id);
    return row.status;
  }
}

function toEntity(row: typeof mediaAssets.$inferSelect): MediaAsset {
  return MediaAsset.rehydrate({
    id: row.id,
    storageKey: row.storageKey,
    // Written only through the allowlist, so a row can hold nothing else.
    contentType: row.contentType as AllowedContentType,
    sizeBytes: row.sizeBytes,
    status: row.status,
    uploadedBy: row.uploadedBy,
    expiresAt: row.expiresAt,
  });
}
