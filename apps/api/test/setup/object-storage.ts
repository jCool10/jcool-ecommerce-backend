import {
  CreateBucketCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { MinioContainer, type StartedMinioContainer } from '@testcontainers/minio';

// Same image the local stack runs, so a suite proves the storage that ships rather than a nearby one.
const STORAGE_IMAGE = 'quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z';
const BUCKET = 'jcool-media-test';
const ACCESS_KEY = 'jcool_test';
const SECRET_KEY = 'jcool_test_pw';

export interface StartedObjectStorage {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  listKeys(prefix?: string): Promise<string[]>;
  exists(key: string): Promise<boolean>;
  /** Writes directly, bypassing the presigned URL — for arranging state a test needs. */
  put(key: string, body: string | Uint8Array, contentType: string): Promise<void>;
  /** One spec's bucket contents must not become another's orphans. */
  clear(): Promise<void>;
  stop(): Promise<void>;
}

export async function startObjectStorage(): Promise<StartedObjectStorage> {
  const container: StartedMinioContainer = await new MinioContainer(STORAGE_IMAGE)
    .withUsername(ACCESS_KEY)
    .withPassword(SECRET_KEY)
    .start();

  const endpoint = container.getConnectionUrl();
  const client = new S3Client({
    endpoint,
    region: 'auto',
    // MinIO has no DNS for `<bucket>.<host>`, so the bucket must stay in the path.
    forcePathStyle: true,
    credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
  });
  await client.send(new CreateBucketCommand({ Bucket: BUCKET }));

  async function listKeys(prefix?: string): Promise<string[]> {
    const keys: string[] = [];
    let continuationToken: string | undefined;
    do {
      const page = await client.send(
        new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, ContinuationToken: continuationToken }),
      );
      for (const object of page.Contents ?? []) {
        if (object.Key) keys.push(object.Key);
      }
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken);
    return keys.sort();
  }

  return {
    endpoint,
    bucket: BUCKET,
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET_KEY,
    listKeys,
    async exists(key: string): Promise<boolean> {
      try {
        await client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
        return true;
      } catch (error) {
        if (typeof error === 'object' && error !== null && 'name' in error && error.name === 'NotFound') return false;
        throw error;
      }
    },
    async put(key: string, body: string | Uint8Array, contentType: string): Promise<void> {
      await client.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: contentType }));
    },
    async clear(): Promise<void> {
      const keys = await listKeys();
      if (keys.length === 0) return;
      await client.send(
        new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: keys.map((Key) => ({ Key })) } }),
      );
    },
    async stop(): Promise<void> {
      client.destroy();
      await container.stop();
    },
  };
}
