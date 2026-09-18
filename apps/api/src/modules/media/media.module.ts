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
 * `MEDIA_FACADE` is the published language and the only export — another context reaches a stored
 * object through it and never sees a storage key, a status, or a bucket. The upload use cases stay
 * unexported: minting an upload URL is an operator action, not one another context takes on request.
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
