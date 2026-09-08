import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v7 as uuidv7 } from 'uuid';
import { OBJECT_STORAGE, type ObjectStoragePort } from '@shared/infrastructure/storage';
import { assertAllowedContentType, extensionFor } from '../../domain/asset-content-type';
import { MediaAsset } from '../../domain/media-asset.entity';
import { MEDIA_ASSET_REPOSITORY, type MediaAssetRepositoryPort } from '../ports/media-asset-repository.port';

export interface InitiateUploadInput {
  contentType: string;
  uploadedBy: string;
}

export interface InitiateUploadResult {
  assetId: string;
  uploadUrl: string;
  headers: Record<string, string>;
  expiresInSec: number;
}

/**
 * The row is written before the URL is signed, so an upload that is never confirmed still has
 * something for the sweep to find. The reverse order would leave objects in the bucket that nothing
 * in the database knows about.
 */
@Injectable()
export class InitiateUploadUseCase {
  private readonly uploadTtlSec: number;

  constructor(
    @Inject(MEDIA_ASSET_REPOSITORY) private readonly repository: MediaAssetRepositoryPort,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStoragePort,
    config: ConfigService,
  ) {
    this.uploadTtlSec = config.getOrThrow<number>('media.uploadTtlSec');
    assertUrlDiesBeforeRow(config.getOrThrow<number>('storage.presignTtlSec'), this.uploadTtlSec);
  }

  async execute(input: InitiateUploadInput): Promise<InitiateUploadResult> {
    const contentType = assertAllowedContentType(input.contentType);
    const assetId = uuidv7();
    const storageKey = `media/${assetId}.${extensionFor(contentType)}`;

    await this.repository.insertPending(
      MediaAsset.pending({
        id: assetId,
        storageKey,
        contentType,
        uploadedBy: input.uploadedBy,
        expiresAt: new Date(Date.now() + this.uploadTtlSec * 1000),
      }),
    );

    const upload = await this.storage.presignPut(storageKey, contentType);
    return { assetId, uploadUrl: upload.url, headers: upload.headers, expiresInSec: upload.expiresInSec };
  }
}

// The two settings have independent ranges, so nothing else stops the presign TTL being the larger.
function assertUrlDiesBeforeRow(presignTtlSec: number, uploadTtlSec: number): void {
  if (presignTtlSec >= uploadTtlSec) {
    throw new Error(
      `STORAGE_PRESIGN_TTL_SEC=${presignTtlSec} is not shorter than MEDIA_UPLOAD_TTL_SEC=${uploadTtlSec}. ` +
        `The sweep would reclaim a PENDING asset while its upload URL is still valid, and the upload ` +
        `that followed would leave an object no row references. Raise MEDIA_UPLOAD_TTL_SEC above ` +
        `${presignTtlSec}, or lower STORAGE_PRESIGN_TTL_SEC.`,
    );
  }
}
