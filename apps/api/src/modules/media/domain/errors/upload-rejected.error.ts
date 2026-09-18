import { DomainError } from '@shared/kernel';

export class UploadRejectedError extends DomainError {
  constructor(
    message: string,
    readonly assetId: string,
  ) {
    super(message);
    this.name = 'UploadRejectedError';
  }
}
