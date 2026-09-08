/**
 * How this process talks to a bucket. Infrastructure, not a context: there is no lifecycle here to
 * protect — Media owns which objects may exist and for how long, this owns only the wire.
 */
export const OBJECT_STORAGE = Symbol('OBJECT_STORAGE');

export interface PresignedUpload {
  url: string;
  /**
   * Sent verbatim by the client. The signature covers them, so a client that changes one is refused
   * by the bucket rather than by this app.
   */
  headers: Record<string, string>;
  expiresInSec: number;
}

export interface StoredObjectHead {
  sizeBytes: number;
  /** Whatever the client sent at PUT — the bucket stores it, it does not verify it. */
  contentType: string | null;
}

export interface ObjectStoragePort {
  /** A URL the client PUTs bytes to directly, so they never pass through this process. */
  presignPut(key: string, contentType: string): Promise<PresignedUpload>;

  /** `null` when the object is absent. Any other failure throws. */
  head(key: string): Promise<StoredObjectHead | null>;

  /** Idempotent — deleting an absent key succeeds, which is what makes a sweep retry safe. */
  delete(key: string): Promise<void>;

  /** A readable URL: the configured public base when there is one, a presigned GET otherwise. */
  publicUrl(key: string): Promise<string>;
}

/** Raised by every call when the bucket was never configured, so the cause names itself. */
export class ObjectStorageNotConfiguredError extends Error {
  constructor() {
    super('Object storage is not configured: set STORAGE_ENDPOINT, STORAGE_BUCKET and the access keys');
    this.name = 'ObjectStorageNotConfiguredError';
  }
}
