import type { DrizzleTx } from '@shared/infrastructure/database/drizzle.tokens';
import type { MediaAsset } from '../../domain/media-asset.entity';

export const MEDIA_ASSET_REPOSITORY = Symbol('MEDIA_ASSET_REPOSITORY');

/** One asset the sweep has claimed and is now responsible for deleting. */
export interface ClaimedAsset {
  id: string;
  storageKey: string;
  /** Null while the upload was never confirmed — the bytes may exist, their size was never measured. */
  sizeBytes: number | null;
}

export interface MediaAssetRepositoryPort {
  insertPending(asset: MediaAsset): Promise<void>;

  findById(id: string): Promise<MediaAsset | null>;

  /** PENDING → READY with the size the bucket reported and a fresh expiry. False if the row moved. */
  markReady(id: string, sizeBytes: number, expiresAt: Date): Promise<boolean>;

  /**
   * Take ownership of up to `limit` reclaimable assets by flipping them to SWEEPING in one
   * statement, and return what was taken. The claim commits before any object is touched, which is
   * what stops an attach and a delete from overlapping.
   *
   * Also picks up rows left at SWEEPING by an interrupted sweep, once they are older than
   * `staleClaimBefore` — a claim that old cannot still be in flight.
   */
  claimForSweep(now: Date, staleClaimBefore: Date, limit: number): Promise<ClaimedAsset[]>;

  /** Deletes a row this sweep claimed. False when something else already removed it. */
  deleteClaimed(id: string): Promise<boolean>;

  /**
   * READY → ATTACHED inside the caller's `tx`, so the attachment commits or rolls back with the row
   * that points at it. Locks first: a sweep claim racing this either waits and then skips, or wins
   * and leaves a status this refuses.
   */
  attach(tx: DrizzleTx, id: string): Promise<void>;

  /** ATTACHED → DETACHED inside the caller's `tx`, restoring the expiry that makes it reclaimable. */
  detach(tx: DrizzleTx, id: string, expiresAt: Date): Promise<void>;

  /** Storage keys for many ids in one read. Ids with no row are simply absent. */
  findStorageKeys(ids: string[]): Promise<{ id: string; storageKey: string }[]>;
}
