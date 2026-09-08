import type { DrizzleTx } from '@shared/infrastructure/database/drizzle.tokens';
import type { MediaAsset } from '../../domain/media-asset.entity';

export const MEDIA_ASSET_REPOSITORY = Symbol('MEDIA_ASSET_REPOSITORY');

export interface ClaimedAsset {
  id: string;
  storageKey: string;
  /** Null while the upload was never confirmed — the bytes may exist, their size was never measured. */
  sizeBytes: number | null;
}

export interface MediaAssetRepositoryPort {
  insertPending(asset: MediaAsset): Promise<void>;

  findById(id: string): Promise<MediaAsset | null>;

  /** False when the row moved on before the write landed. */
  markReady(id: string, sizeBytes: number, expiresAt: Date): Promise<boolean>;

  /**
   * The claim commits before any object is touched, which is what stops an attach and a delete from
   * overlapping. Also re-takes rows an interrupted sweep left at SWEEPING once they are older than
   * `staleClaimBefore` — a claim that old cannot still be in flight.
   */
  claimForSweep(now: Date, staleClaimBefore: Date, limit: number): Promise<ClaimedAsset[]>;

  /** Deletes a row this sweep claimed. False when something else already removed it. */
  deleteClaimed(id: string): Promise<boolean>;

  /** READY → ATTACHED inside the caller's `tx`, so it commits or rolls back with the row pointing at it. */
  attach(tx: DrizzleTx, id: string): Promise<void>;

  /** ATTACHED → DETACHED inside the caller's `tx`, restoring the expiry that makes it reclaimable. */
  detach(tx: DrizzleTx, id: string, expiresAt: Date): Promise<void>;

  /** Ids with no row are simply absent from the result. */
  findStorageKeys(ids: string[]): Promise<{ id: string; storageKey: string }[]>;
}
