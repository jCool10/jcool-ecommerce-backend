import { describe, expect, it } from 'vitest';
import { S3ObjectStorageAdapter, type S3ObjectStorageOptions } from './s3-object-storage.adapter';

// Signing is offline, so these exercise the real SDK without a bucket. `head`/`delete` need a
// server and are covered by the media e2e against MinIO.
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
  it('signs the content type into the upload URL, so the bucket refuses a different one', async () => {
    const upload = await build().presignPut('products/abc.webp', 'image/webp');
    const url = new URL(upload.url);

    expect(url.pathname).toBe('/jcool-media/products/abc.webp');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toContain('content-type');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(upload.headers).toEqual({ 'Content-Type': 'image/webp' });
  });

  it('serves from the public base when there is one, with nothing to expire', async () => {
    const url = await build({ publicBaseUrl: 'https://cdn.test/media/' }).publicUrl('products/abc.webp');

    expect(url).toBe('https://cdn.test/media/products/abc.webp');
  });

  it('falls back to a presigned GET that renders inline under a server-minted filename', async () => {
    const url = new URL(await build().publicUrl('products/abc.webp'));

    expect(url.searchParams.get('response-content-disposition')).toBe('inline; filename="abc.webp"');
    expect(url.searchParams.get('X-Amz-Signature')).toBeTruthy();
  });
});
