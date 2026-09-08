import type { ConfigService } from '@nestjs/config';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ObjectStoragePort } from '@shared/infrastructure/storage';
import { UnsupportedContentTypeError } from '../../domain/asset-content-type';
import type { MediaAsset } from '../../domain/media-asset.entity';
import type { MediaAssetRepositoryPort } from '../ports/media-asset-repository.port';
import { InitiateUploadUseCase } from './initiate-upload.use-case';

const UPLOAD_TTL_SEC = 3600;
const PRESIGN_TTL_SEC = 900;

const configWith = (presignTtlSec: number, uploadTtlSec = UPLOAD_TTL_SEC) =>
  ({
    getOrThrow: (key: string) => (key === 'storage.presignTtlSec' ? presignTtlSec : uploadTtlSec),
  }) as unknown as ConfigService;

function build() {
  const calls: string[] = [];
  const inserted: MediaAsset[] = [];

  const insertPending = vi.fn((asset: MediaAsset) => {
    calls.push('insert');
    inserted.push(asset);
    return Promise.resolve();
  });
  const presignPut = vi.fn((_key: string, contentType: string) => {
    calls.push('presign');
    return Promise.resolve({
      url: 'https://bucket.example/put',
      headers: { 'Content-Type': contentType },
      expiresInSec: 900,
    });
  });

  const useCase = new InitiateUploadUseCase(
    { insertPending } as unknown as MediaAssetRepositoryPort,
    { presignPut } as unknown as ObjectStoragePort,
    configWith(PRESIGN_TTL_SEC),
  );
  return { useCase, calls, inserted, presignPut };
}

describe('InitiateUploadUseCase', () => {
  let ctx: ReturnType<typeof build>;

  beforeEach(() => {
    ctx = build();
  });

  it('writes the row before signing, so an abandoned upload is always sweepable', async () => {
    await ctx.useCase.execute({ contentType: 'image/png', uploadedBy: 'admin-1' });

    expect(ctx.calls).toEqual(['insert', 'presign']);
  });

  it('mints the storage key from the id and the server-side extension table', async () => {
    const result = await ctx.useCase.execute({ contentType: 'image/webp', uploadedBy: 'admin-1' });

    expect(ctx.inserted[0].storageKey).toBe(`media/${result.assetId}.webp`);
    expect(ctx.presignPut).toHaveBeenCalledWith(ctx.inserted[0].storageKey, 'image/webp');
  });

  it('gives the row an expiry so an unconfirmed upload does not live forever', async () => {
    const before = Date.now();
    await ctx.useCase.execute({ contentType: 'image/png', uploadedBy: 'admin-1' });

    const expiresAt = ctx.inserted[0].expiresAt?.getTime() ?? 0;
    expect(expiresAt).toBeGreaterThanOrEqual(before + UPLOAD_TTL_SEC * 1000);
  });

  it('refuses an unsupported type before reserving anything', async () => {
    await expect(ctx.useCase.execute({ contentType: 'image/svg+xml', uploadedBy: 'admin-1' })).rejects.toBeInstanceOf(
      UnsupportedContentTypeError,
    );
    expect(ctx.calls).toEqual([]);
  });

  // A URL that outlives its row means the sweep reclaims the row while the PUT still works, and the
  // upload lands as an object nothing references. Both settings validate fine on their own.
  it.each([
    ['longer than', UPLOAD_TTL_SEC + 1],
    ['equal to', UPLOAD_TTL_SEC],
  ])('refuses to construct when the presign TTL is %s the upload TTL', (_case, presignTtlSec) => {
    expect(
      () =>
        new InitiateUploadUseCase(
          {} as unknown as MediaAssetRepositoryPort,
          {} as unknown as ObjectStoragePort,
          configWith(presignTtlSec),
        ),
    ).toThrow(/STORAGE_PRESIGN_TTL_SEC/);
  });
});
