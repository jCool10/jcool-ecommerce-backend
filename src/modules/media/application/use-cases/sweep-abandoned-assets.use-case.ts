import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OBJECT_STORAGE, type ObjectStoragePort } from '@shared/infrastructure/storage';
import { METRICS, type MetricsPort } from '@shared/observability/metrics/metrics.port';
import { RetentionSweepRegistry, type RetentionSweep } from '@shared/retention';
import { MEDIA_ASSET_REPOSITORY, type MediaAssetRepositoryPort } from '../ports/media-asset-repository.port';

/**
 * Reclaims uploads nothing ever claimed — the media half of the same idea as the reservation sweep,
 * with one extra step that reservations do not need.
 *
 * Deleting bytes cannot be undone, so the claim is committed first: one statement moves a batch to
 * SWEEPING and returns it, and only then is the bucket touched. Without that step an attach
 * committing between selecting a row and deleting its object leaves a live product pointing at
 * nothing — a `status IN (...)` guard on the DELETE protects the row and does nothing for the object
 * that is already gone.
 *
 * Object first, row second. A crash between them leaves a SWEEPING row that the next pass finds
 * again, and deleting an absent object is a no-op — so the retry is safe. The reverse order would
 * leave objects in the bucket that nothing in the database remembers.
 */
@Injectable()
export class SweepAbandonedAssetsUseCase implements RetentionSweep, OnModuleInit {
  readonly name = 'media:assets';
  private readonly staleClaimMs: number;

  constructor(
    @Inject(MEDIA_ASSET_REPOSITORY) private readonly repository: MediaAssetRepositoryPort,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStoragePort,
    @Inject(METRICS) private readonly metrics: MetricsPort,
    config: ConfigService,
    private readonly registry: RetentionSweepRegistry,
  ) {
    // A claim older than the scheduler's own per-sweep timeout cannot still be in flight: by then
    // the scheduler has stopped waiting on that pass and will not start another for this sweep.
    this.staleClaimMs = config.getOrThrow<number>('retention.sweepTimeoutMs');
  }

  onModuleInit(): void {
    this.registry.register(this);
  }

  async sweep(batchSize: number): Promise<number> {
    const now = new Date();
    const claimed = await this.repository.claimForSweep(now, new Date(now.getTime() - this.staleClaimMs), batchSize);

    let deleted = 0;
    for (const asset of claimed) {
      // Serial, not `Promise.all`: the batch is the unit of work the scheduler timed, and firing a
      // whole batch of bucket deletes at once turns one slow storage day into a timed-out sweep.
      await this.storage.delete(asset.storageKey);
      if (await this.repository.deleteClaimed(asset.id)) {
        deleted += 1;
        this.metrics.recordMediaBytesReclaimed(asset.sizeBytes ?? 0);
      }
    }
    return deleted;
  }
}
