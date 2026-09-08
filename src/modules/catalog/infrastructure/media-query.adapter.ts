import { Inject, Injectable } from '@nestjs/common';
import { MEDIA_FACADE, type MediaFacade } from '@modules/media/application/public/media-facade.port';
import type { MediaQueryPort } from '../application/ports';

/** The seam between Catalog and Media: the only place in this context that knows Media exists. */
@Injectable()
export class MediaQueryAdapter implements MediaQueryPort {
  constructor(@Inject(MEDIA_FACADE) private readonly media: MediaFacade) {}

  resolveUrls(assetIds: string[]): Promise<Map<string, string>> {
    return this.media.getPublicUrls(assetIds);
  }
}
