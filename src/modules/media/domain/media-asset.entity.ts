import { assertNonEmpty } from '@shared/kernel';
import type { AllowedContentType } from './asset-content-type';
import { AssetStatus } from './asset-status';

/**
 * One uploadable object and the state it is in. Pure domain object, created PENDING.
 *
 * `expiresAt` is the same idea as a reservation's: the moment the sweep may take it back. It is
 * null in exactly one state, ATTACHED — an asset in use is not reclaimable, and every other state
 * must remain selectable by an `expires_at < now()` sweep or it would never be collected.
 */
export class MediaAsset {
  private constructor(
    public readonly id: string,
    public readonly storageKey: string,
    public readonly contentType: AllowedContentType,
    public readonly sizeBytes: number | null,
    public readonly status: AssetStatus,
    public readonly uploadedBy: string,
    public readonly expiresAt: Date | null,
  ) {}

  /** A fresh PENDING asset: the key is reserved and an upload URL may be signed for it. */
  static pending(props: {
    id: string;
    storageKey: string;
    contentType: AllowedContentType;
    uploadedBy: string;
    expiresAt: Date;
  }): MediaAsset {
    assertNonEmpty(props.id, 'MediaAsset.id');
    assertNonEmpty(props.storageKey, 'MediaAsset.storageKey');
    assertNonEmpty(props.uploadedBy, 'MediaAsset.uploadedBy');
    return new MediaAsset(
      props.id,
      props.storageKey,
      props.contentType,
      // Unknown until the upload is confirmed: the size is whatever the bucket reports, never what
      // the client claimed.
      null,
      AssetStatus.PENDING,
      props.uploadedBy,
      props.expiresAt,
    );
  }

  /** Reconstruct from a persisted row (repository use only). */
  static rehydrate(props: {
    id: string;
    storageKey: string;
    contentType: AllowedContentType;
    sizeBytes: number | null;
    status: AssetStatus;
    uploadedBy: string;
    expiresAt: Date | null;
  }): MediaAsset {
    return new MediaAsset(
      props.id,
      props.storageKey,
      props.contentType,
      props.sizeBytes,
      props.status,
      props.uploadedBy,
      props.expiresAt,
    );
  }
}
