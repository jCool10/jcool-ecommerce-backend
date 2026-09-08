/**
 * Asset lifecycle states. Const object + union type, matching ReservationStatus and OrderStatus, so
 * the string values are identical to the `media_asset_status` pg enum. Declaration order matches it.
 */
export const AssetStatus = {
  /** A row exists and an upload URL was handed out; the bytes may or may not be there yet. */
  PENDING: 'PENDING',
  /** The upload was confirmed against the bucket. Nothing points at it yet. */
  READY: 'READY',
  /** In use by a product. This is the only state with no expiry. */
  ATTACHED: 'ATTACHED',
  /** Taken off its product and reclaimable again. */
  DETACHED: 'DETACHED',
  /**
   * Claimed by the sweep. Terminal by design: the bytes are already committed to deletion, so an
   * attach arriving now must be refused rather than served an object that is about to vanish.
   */
  SWEEPING: 'SWEEPING',
} as const;

export type AssetStatus = (typeof AssetStatus)[keyof typeof AssetStatus];

/** All statuses, in declaration order — the pg enum and exhaustive test iteration read this. */
export const ASSET_STATUSES: readonly AssetStatus[] = Object.values(AssetStatus);

/** The states a sweep may claim: everything that is not attached and not already claimed. */
export const RECLAIMABLE_STATUSES: readonly AssetStatus[] = [
  AssetStatus.PENDING,
  AssetStatus.READY,
  AssetStatus.DETACHED,
];
