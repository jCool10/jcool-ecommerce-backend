import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { DrizzleTx } from '@shared/infrastructure/database/drizzle.tokens';
import { OBJECT_STORAGE, type ObjectStoragePort } from '@shared/infrastructure/storage';
import { AssetTransitionError } from '../../domain/asset-state-machine';
import { MediaAssetNotFoundError } from '../../domain/errors/media-asset-not-found.error';
import { MEDIA_ASSET_REPOSITORY, type MediaAssetRepositoryPort } from '../ports/media-asset-repository.port';
import { MediaAssetUnavailableError, type MediaFacade } from '../public/media-facade.port';

@Injectable()
export class MediaFacadeService implements MediaFacade {
  private readonly readyTtlSec: number;

  constructor(
    @Inject(MEDIA_ASSET_REPOSITORY) private readonly repository: MediaAssetRepositoryPort,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStoragePort,
    config: ConfigService,
  ) {
    this.readyTtlSec = config.getOrThrow<number>('media.readyTtlSec');
  }

  async getPublicUrls(assetIds: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(assetIds)];
    if (unique.length === 0) return new Map();

    const rows = await this.repository.findStorageKeys(unique);
    // Signing is local arithmetic, not a request, so resolving a page of images costs one query and
    // no round trips.
    const entries = await Promise.all(
      rows.map(async (row) => [row.id, await this.storage.publicUrl(row.storageKey)] as const),
    );
    return new Map(entries);
  }

  async attach(tx: DrizzleTx, assetId: string): Promise<void> {
    try {
      await this.repository.attach(tx, assetId);
    } catch (error) {
      throw this.translate(error, assetId);
    }
  }

  async detach(tx: DrizzleTx, assetId: string): Promise<void> {
    try {
      // Restores an expiry rather than deleting anything: a bucket call inside the caller's
      // transaction would hold a connection across the network, so the bytes go when the sweep does.
      await this.repository.detach(tx, assetId, new Date(Date.now() + this.readyTtlSec * 1000));
    } catch (error) {
      // Nothing left to give back, and dropping the link row is exactly the repair for an asset whose
      // row is already gone. The lookup found no row rather than failing, so the caller's tx commits.
      if (error instanceof MediaAssetNotFoundError) return;
      throw this.translate(error, assetId);
    }
  }

  private translate(error: unknown, assetId: string): unknown {
    if (error instanceof MediaAssetNotFoundError) {
      return new MediaAssetUnavailableError(`Media asset ${assetId} does not exist`, assetId);
    }
    if (error instanceof AssetTransitionError) {
      return new MediaAssetUnavailableError(
        `Media asset ${assetId} is ${error.from} and cannot become ${error.to}`,
        assetId,
      );
    }
    return error;
  }
}
