import { Inject, Injectable } from '@nestjs/common';
import { MEDIA_FACADE, type MediaFacade } from '@modules/media/application/public/media-facade.port';
import type { MediaQueryPort } from '../../application/catalog/ports';

@Injectable()
export class MediaQueryAdapter implements MediaQueryPort {
  constructor(@Inject(MEDIA_FACADE) private readonly mediaFacade: MediaFacade) {}

  resolveUrls(assetIds: string[]): Promise<Map<string, string>> {
    return this.mediaFacade.getPublicUrls(assetIds);
  }
}
