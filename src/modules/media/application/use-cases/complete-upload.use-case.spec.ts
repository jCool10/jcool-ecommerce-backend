import type { ConfigService } from '@nestjs/config';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ObjectStoragePort, StoredObjectHead } from '@shared/infrastructure/storage';
import { AssetTransitionError } from '../../domain/asset-state-machine';
import { AssetStatus } from '../../domain/asset-status';
import { MediaAssetNotFoundError } from '../../domain/errors/media-asset-not-found.error';
import { UploadRejectedError } from '../../domain/errors/upload-rejected.error';
import { MediaAsset } from '../../domain/media-asset.entity';
import type { MediaAssetRepositoryPort } from '../ports/media-asset-repository.port';
import { CompleteUploadUseCase } from './complete-upload.use-case';

const MAX_BYTES = 1024;
const READY_TTL_SEC = 86_400;
const CONFIG: Record<string, number> = { 'media.maxBytes': MAX_BYTES, 'media.readyTtlSec': READY_TTL_SEC };

function asset(status: AssetStatus = AssetStatus.PENDING): MediaAsset {
  return MediaAsset.rehydrate({
    id: 'asset-1',
    storageKey: 'media/asset-1.png',
    contentType: 'image/png',
    sizeBytes: null,
    status,
    uploadedBy: 'admin-1',
    expiresAt: new Date(),
  });
}

function build(overrides: { asset?: MediaAsset | null; head?: StoredObjectHead | null; markReady?: boolean } = {}) {
  const findById = vi.fn(() => Promise.resolve(overrides.asset === undefined ? asset() : overrides.asset));
  const markReady = vi.fn((_id: string, _sizeBytes: number, _expiresAt: Date) =>
    Promise.resolve(overrides.markReady ?? true),
  );
  const head = vi.fn(() =>
    Promise.resolve(overrides.head === undefined ? { sizeBytes: 512, contentType: 'image/png' } : overrides.head),
  );

  const config = { getOrThrow: (key: string) => CONFIG[key] } as unknown as ConfigService;
  const useCase = new CompleteUploadUseCase(
    { findById, markReady } as unknown as MediaAssetRepositoryPort,
    { head } as unknown as ObjectStoragePort,
    config,
  );
  return { useCase, markReady };
}

describe('CompleteUploadUseCase', () => {
  let ctx: ReturnType<typeof build>;

  beforeEach(() => {
    ctx = build();
  });

  it('records the size the bucket reported and extends the expiry', async () => {
    const before = Date.now();
    await ctx.useCase.execute('asset-1');

    const [id, sizeBytes, expiresAt] = ctx.markReady.mock.calls[0];
    expect(id).toBe('asset-1');
    expect(sizeBytes).toBe(512);
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + READY_TTL_SEC * 1000);
  });

  it('throws when the asset does not exist', async () => {
    await expect(build({ asset: null }).useCase.execute('asset-1')).rejects.toBeInstanceOf(MediaAssetNotFoundError);
  });

  it('refuses to confirm an asset that already left PENDING', async () => {
    await expect(build({ asset: asset(AssetStatus.ATTACHED) }).useCase.execute('asset-1')).rejects.toBeInstanceOf(
      AssetTransitionError,
    );
  });

  it('rejects when nothing was actually uploaded', async () => {
    const { useCase, markReady } = build({ head: null });

    await expect(useCase.execute('asset-1')).rejects.toBeInstanceOf(UploadRejectedError);
    expect(markReady).not.toHaveBeenCalled();
  });

  it('rejects an object over the size limit — the signature could not have capped it', async () => {
    const { useCase } = build({ head: { sizeBytes: MAX_BYTES + 1, contentType: 'image/png' } });

    await expect(useCase.execute('asset-1')).rejects.toBeInstanceOf(UploadRejectedError);
  });

  it('rejects an object whose stored type disagrees with what was signed', async () => {
    const { useCase } = build({ head: { sizeBytes: 10, contentType: 'image/jpeg' } });

    await expect(useCase.execute('asset-1')).rejects.toBeInstanceOf(UploadRejectedError);
  });

  it('rejects when the row moved underneath the confirmation', async () => {
    const { useCase } = build({ markReady: false });

    await expect(useCase.execute('asset-1')).rejects.toBeInstanceOf(UploadRejectedError);
  });
});
