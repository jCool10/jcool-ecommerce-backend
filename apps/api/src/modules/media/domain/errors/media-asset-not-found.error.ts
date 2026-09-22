import { DomainError } from '@jcool/kernel';

export class MediaAssetNotFoundError extends DomainError {
  constructor(readonly assetId: string) {
    super(`Media asset ${assetId} does not exist`);
    this.name = 'MediaAssetNotFoundError';
  }
}
