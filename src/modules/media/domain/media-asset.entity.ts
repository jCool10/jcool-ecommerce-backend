import { assertNonEmpty } from '@shared/kernel';
import type { AllowedContentType } from './asset-content-type';
import { AssetStatus } from './asset-status';

/**
 * `expiresAt` is the moment the sweep may take the asset back. It is null in exactly one state,
 * ATTACHED — every other state must remain selectable by an `expires_at < now()` sweep or it would
 * never be collected.
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
      // Size: unknown until the upload is confirmed, and then whatever the bucket reports rather
      // than what the client claimed.
      null,
      AssetStatus.PENDING,
      props.uploadedBy,
      props.expiresAt,
    );
  }

  /** Repository use only: none of the invariants `pending` asserts are re-checked. */
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
