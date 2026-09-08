import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OBJECT_STORAGE, type ObjectStoragePort } from '@shared/infrastructure/storage';
import { assertTransition } from '../../domain/asset-state-machine';
import { AssetStatus } from '../../domain/asset-status';
import { MediaAssetNotFoundError } from '../../domain/errors/media-asset-not-found.error';
import { UploadRejectedError } from '../../domain/errors/upload-rejected.error';
import { MEDIA_ASSET_REPOSITORY, type MediaAssetRepositoryPort } from '../ports/media-asset-repository.port';

/**
 * The size limit lives here because this is the first place it can: a presigned PUT signs an exact
 * Content-Length, never a maximum. A rejected upload is left PENDING on purpose — the sweep then
 * deletes both the oversized object and its row, so a refusal costs no storage.
 */
@Injectable()
export class CompleteUploadUseCase {
  private readonly maxBytes: number;
  private readonly readyTtlSec: number;

  constructor(
    @Inject(MEDIA_ASSET_REPOSITORY) private readonly repository: MediaAssetRepositoryPort,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStoragePort,
    config: ConfigService,
  ) {
    this.maxBytes = config.getOrThrow<number>('media.maxBytes');
    this.readyTtlSec = config.getOrThrow<number>('media.readyTtlSec');
  }

  async execute(assetId: string): Promise<void> {
    const asset = await this.repository.findById(assetId);
    if (!asset) throw new MediaAssetNotFoundError(assetId);
    assertTransition(asset.status, AssetStatus.READY);

    const head = await this.storage.head(asset.storageKey);
    if (!head) throw new UploadRejectedError('No object was uploaded for this asset', assetId);

    if (head.sizeBytes > this.maxBytes) {
      throw new UploadRejectedError(`Object is ${head.sizeBytes} bytes, over the ${this.maxBytes} limit`, assetId);
    }
    // Defence in depth, not the control: the bucket reports back whatever the client sent, so this
    // only proves the client was consistent with itself. The signed Content-Type is what actually
    // stops a different type being uploaded.
    if (head.contentType && head.contentType !== asset.contentType) {
      throw new UploadRejectedError(`Object is ${head.contentType}, but ${asset.contentType} was signed for`, assetId);
    }

    // Extended, never cleared: an asset with no expiry can never be selected by the sweep, so only
    // a successful attach earns a null one.
    const moved = await this.repository.markReady(
      assetId,
      head.sizeBytes,
      new Date(Date.now() + this.readyTtlSec * 1000),
    );
    if (!moved) throw new UploadRejectedError('The asset changed state while its upload was being confirmed', assetId);
  }
}
