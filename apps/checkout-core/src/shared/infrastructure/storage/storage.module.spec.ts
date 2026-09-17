import { fakeConfigService } from '@shared/testing/fake-config.service';
import { describe, expect, it } from 'vitest';
import { ObjectStorageNotConfiguredError } from './object-storage.port';
import { S3ObjectStorageAdapter } from './s3-object-storage.adapter';
import { createObjectStorage } from './storage.module';

const configured = {
  'storage.endpoint': 'http://storage.test:9000',
  'storage.bucket': 'jcool-media',
  'storage.accessKeyId': 'key',
  'storage.secretAccessKey': 'secret',
  'storage.region': 'auto',
  'storage.presignTtlSec': 900,
};

describe('createObjectStorage', () => {
  it('builds the S3 adapter once every setting is present', () => {
    expect(createObjectStorage(fakeConfigService({ 'app.env': 'production', ...configured }))).toBeInstanceOf(
      S3ObjectStorageAdapter,
    );
  });

  it('keeps a dev app booting without a bucket, and fails only where storage is used', async () => {
    const storage = createObjectStorage(fakeConfigService({ 'app.env': 'development' }));

    await expect(storage.presignPut('products/a.webp', 'image/webp')).rejects.toThrow(ObjectStorageNotConfiguredError);
  });

  // A half-set group is the dangerous shape: it reads as configured and signs URLs for an endpoint
  // nobody chose.
  it('refuses to boot in production with the group half set', () => {
    const values = { 'app.env': 'production', ...configured, 'storage.secretAccessKey': '  ' };

    expect(() => createObjectStorage(fakeConfigService(values))).toThrow(/Object storage is required in production/);
  });
});
