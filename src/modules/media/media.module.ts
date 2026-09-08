import { Module } from '@nestjs/common';
import { StorageModule } from '@shared/infrastructure/storage';
import { MediaFacadeService } from './application/services/media-facade.service';
import { MEDIA_ASSET_REPOSITORY } from './application/ports/media-asset-repository.port';
import { MEDIA_FACADE } from './application/public/media-facade.port';
import { CompleteUploadUseCase } from './application/use-cases/complete-upload.use-case';
import { InitiateUploadUseCase } from './application/use-cases/initiate-upload.use-case';
import { SweepAbandonedAssetsUseCase } from './application/use-cases/sweep-abandoned-assets.use-case';
import { DrizzleMediaAssetRepository } from './infrastructure/drizzle-media-asset.repository';
import { MEDIA_SWEEPING_PROVIDERS } from './infrastructure/media-sweeping.collector';
import { MediaController } from './interface/media.controller';

/**
 * Media bounded context: the lifecycle of an uploaded object, from a signed URL to the sweep that
 * takes the bytes back. It owns `media_assets`; the bucket itself is infrastructure, reached only
 * through `StorageModule`.
 *
 * `MEDIA_FACADE` is the published language and the only export — Catalog attaches an image through
 * it, inside Catalog's own transaction, the same way Order holds stock through `STOCK_RESERVATION`.
 * The upload use cases are not exported: minting an upload URL is an operator action, not something
 * another context does on anyone's behalf.
 *
 * The sweep registers itself with the shared `RetentionScheduler` rather than starting a timer, so
 * `RETENTION_ENABLED` governs it along with every other table's reclamation and this context adds
 * no background driver of its own.
 */
@Module({
  imports: [StorageModule],
  controllers: [MediaController],
  providers: [
    InitiateUploadUseCase,
    CompleteUploadUseCase,
    SweepAbandonedAssetsUseCase,
    MediaFacadeService,
    { provide: MEDIA_ASSET_REPOSITORY, useClass: DrizzleMediaAssetRepository },
    { provide: MEDIA_FACADE, useExisting: MediaFacadeService },
    ...MEDIA_SWEEPING_PROVIDERS,
  ],
  exports: [MEDIA_FACADE],
})
export class MediaModule {}
