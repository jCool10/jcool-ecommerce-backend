import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  OBJECT_STORAGE,
  ObjectStorageNotConfiguredError,
  type ObjectStoragePort,
  type PresignedUpload,
  type StoredObjectHead,
} from './object-storage.port';
import { S3ObjectStorageAdapter } from './s3-object-storage.adapter';

/**
 * Every call fails, and says why. There is no offline equivalent of a bucket — a local-disk stand-in
 * would be a second implementation that only ever runs where it cannot be trusted — so an
 * unconfigured app keeps booting and serving everything else, and only the media routes break.
 */
class UnconfiguredObjectStorage implements ObjectStoragePort {
  presignPut(): Promise<PresignedUpload> {
    return Promise.reject(new ObjectStorageNotConfiguredError());
  }
  head(): Promise<StoredObjectHead | null> {
    return Promise.reject(new ObjectStorageNotConfiguredError());
  }
  delete(): Promise<void> {
    return Promise.reject(new ObjectStorageNotConfiguredError());
  }
  publicUrl(): Promise<string> {
    return Promise.reject(new ObjectStorageNotConfiguredError());
  }
}

/**
 * Presence of the bucket settings is the switch, the way `SMTP_URL` and `SENTRY_DSN` are. In
 * production a half-set group is a boot failure: partially configured storage would mint upload
 * URLs against the wrong endpoint rather than fail.
 */
export function createObjectStorage(config: ConfigService): ObjectStoragePort {
  const endpoint = config.get<string>('storage.endpoint')?.trim();
  const bucket = config.get<string>('storage.bucket')?.trim();
  const accessKeyId = config.get<string>('storage.accessKeyId')?.trim();
  const secretAccessKey = config.get<string>('storage.secretAccessKey')?.trim();

  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    if (config.get<string>('app.env') === 'production') {
      throw new Error(
        'Object storage is required in production: set STORAGE_ENDPOINT, STORAGE_BUCKET, STORAGE_ACCESS_KEY_ID and STORAGE_SECRET_ACCESS_KEY',
      );
    }
    return new UnconfiguredObjectStorage();
  }

  return new S3ObjectStorageAdapter({
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    region: config.getOrThrow<string>('storage.region'),
    presignTtlSec: config.getOrThrow<number>('storage.presignTtlSec'),
    publicBaseUrl: config.get<string>('storage.publicBaseUrl')?.trim() || undefined,
  });
}

@Module({
  providers: [{ provide: OBJECT_STORAGE, inject: [ConfigService], useFactory: createObjectStorage }],
  exports: [OBJECT_STORAGE],
})
export class StorageModule {}
