/** Values and declaration order must stay identical to the `media_asset_status` pg enum. */
export const AssetStatus = {
  PENDING: 'PENDING',
  READY: 'READY',
  /** In use by a product. The only state with no expiry. */
  ATTACHED: 'ATTACHED',
  DETACHED: 'DETACHED',
  /**
   * Claimed by the sweep. Terminal by design: the bytes are already committed to deletion, so an
   * attach arriving now must be refused rather than served an object that is about to vanish.
   */
  SWEEPING: 'SWEEPING',
} as const;

export type AssetStatus = (typeof AssetStatus)[keyof typeof AssetStatus];

export const ASSET_STATUSES: readonly AssetStatus[] = Object.values(AssetStatus);

export const RECLAIMABLE_STATUSES: readonly AssetStatus[] = [
  AssetStatus.PENDING,
  AssetStatus.READY,
  AssetStatus.DETACHED,
];
