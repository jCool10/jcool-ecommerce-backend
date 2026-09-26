import { describe, expect, it } from 'vitest';
import { S3ObjectStorageAdapter, type S3ObjectStorageOptions } from './s3-object-storage.adapter';

// Signing is offline, so these run the real SDK without a bucket.
const options: S3ObjectStorageOptions = {
  endpoint: 'http://storage.test:9000',
  bucket: 'jcool-media',
  region: 'auto',
  accessKeyId: 'key',
  secretAccessKey: 'secret',
  presignTtlSec: 900,
};

const build = (overrides: Partial<S3ObjectStorageOptions> = {}) =>
  new S3ObjectStorageAdapter({ ...options, ...overrides });

describe('S3ObjectStorageAdapter', () => {
  it('serves from the public base when there is one, with nothing to expire', async () => {
    const url = await build({ publicBaseUrl: 'https://cdn.test/media/' }).publicUrl('products/abc.webp');

    expect(url).toBe('https://cdn.test/media/products/abc.webp');
  });

  it('falls back to a presigned GET rendered inline under a minted filename', async () => {
    const url = new URL(await build().publicUrl('products/abc.webp'));

    expect(url.searchParams.get('response-content-disposition')).toBe('inline; filename="abc.webp"');
    expect(url.searchParams.get('X-Amz-Signature')).toBeTruthy();
  });

  it('signs no body checksum into a presigned PUT, which the browser uploads unchecksummed', async () => {
    const { url } = await build().presignPut('products/abc.webp', 'image/webp');
    const params = [...new URL(url).searchParams.keys()].map((key) => key.toLowerCase());

    expect(params.filter((key) => key.startsWith('x-amz-checksum') || key === 'x-amz-sdk-checksum-algorithm')).toEqual(
      [],
    );
  });
});
