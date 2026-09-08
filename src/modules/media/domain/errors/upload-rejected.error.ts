import { DomainError } from '@shared/kernel';

/**
 * The bytes are not acceptable, so the asset stays PENDING and the sweep reclaims both the row and
 * whatever was uploaded. Rejecting here rather than at the bucket is forced by the mechanism: a v4
 * signature pins Content-Length to one exact value and cannot express a ceiling.
 */
export class UploadRejectedError extends DomainError {
  constructor(
    message: string,
    readonly assetId: string,
  ) {
    super(message);
    this.name = 'UploadRejectedError';
  }
}
