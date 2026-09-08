import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { ObjectStoragePort, PresignedUpload, StoredObjectHead } from './object-storage.port';

export interface S3ObjectStorageOptions {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Lifetime of both the upload URL and, where there is no public base, the read URL. */
  presignTtlSec: number;
  /** Set → stable public URLs (an R2 public domain or CDN); unset → a presigned GET per read. */
  publicBaseUrl?: string;
  /** Test seam: an already-built client, so a suite can point at a container. */
  client?: S3Client;
}

/**
 * Path-style addressing throughout: MinIO only serves that way and R2 accepts it, so one adapter
 * covers both (R2 in production, MinIO locally) without a mode.
 */
export class S3ObjectStorageAdapter implements ObjectStoragePort {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly presignTtlSec: number;
  private readonly publicBaseUrl?: string;

  constructor(options: S3ObjectStorageOptions) {
    this.client =
      options.client ??
      new S3Client({
        endpoint: options.endpoint,
        region: options.region,
        forcePathStyle: true,
        credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
      });
    this.bucket = options.bucket;
    this.presignTtlSec = options.presignTtlSec;
    this.publicBaseUrl = options.publicBaseUrl?.replace(/\/+$/, '');
  }

  async presignPut(key: string, contentType: string): Promise<PresignedUpload> {
    // Signing `Content-Type` is the only constraint a presigned PUT actually enforces. Size is not
    // enforceable this way — a v4 signature pins Content-Length to one exact value, never to a
    // ceiling — so the size limit lives at `complete` instead.
    const url = await getSignedUrl(
      this.client,
      new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }),
      // `signableHeaders` is what makes the guarantee real: without it the presigner hoists
      // content-type into the query string, where the client can send whatever it likes and the
      // signature still verifies.
      { expiresIn: this.presignTtlSec, signableHeaders: new Set(['content-type']) },
    );
    return { url, headers: { 'Content-Type': contentType }, expiresInSec: this.presignTtlSec };
  }

  async head(key: string): Promise<StoredObjectHead | null> {
    try {
      const result = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { sizeBytes: result.ContentLength ?? 0, contentType: result.ContentType ?? null };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async publicUrl(key: string): Promise<string> {
    if (this.publicBaseUrl) return `${this.publicBaseUrl}/${key}`;

    // The filename is derived from the key, which this app minted — a client-supplied name never
    // reaches here. `inline` keeps an image an image; `nosniff` cannot be signed onto a GET and is
    // configured at the bucket or CDN instead (RUNBOOK).
    const filename = key.slice(key.lastIndexOf('/') + 1);
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: `inline; filename="${filename}"`,
      }),
      { expiresIn: this.presignTtlSec },
    );
  }
}

/** HEAD carries no error body, so the status code is all there is to read. */
function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { name, $metadata } = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return name === 'NotFound' || name === 'NoSuchKey' || $metadata?.httpStatusCode === 404;
}
