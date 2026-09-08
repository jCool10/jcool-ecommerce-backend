import { DomainError } from '@shared/kernel';
// Type-only, from the tokens file rather than the barrel: importing the barrel would pull the
// runtime drizzle module into the application layer.
import type { DrizzleTx } from '@shared/infrastructure/database/drizzle.tokens';

// The ONLY way another context reaches a stored object. Nothing outside Media sees a storage key,
// a status, or a bucket.
export const MEDIA_FACADE = Symbol('MEDIA_FACADE');

/** The one failure type a cross-context caller maps: the asset cannot take on that role. */
export class MediaAssetUnavailableError extends DomainError {
  constructor(
    message: string,
    public readonly assetId: string,
  ) {
    super(message);
    this.name = 'MediaAssetUnavailableError';
  }
}

export interface MediaFacade {
  /**
   * Readable URLs for many assets in one call, keyed by asset id — the same shape as
   * `getSkuViews`, and for the same reason: a caller holding a page of products must not make one
   * round trip per image. An id with no asset is absent from the map rather than null-filled.
   *
   * Resolved on the way out, never stored: a presigned URL put into a cache outlives its signature.
   */
  getPublicUrls(assetIds: string[]): Promise<Map<string, string>>;

  /** Claims the asset inside the caller's `tx`, so it commits or rolls back with the row that references it. */
  attach(tx: DrizzleTx, assetId: string): Promise<void>;

  /** Gives the asset back inside the caller's `tx`; from here a sweep may reclaim it. */
  detach(tx: DrizzleTx, assetId: string): Promise<void>;
}
