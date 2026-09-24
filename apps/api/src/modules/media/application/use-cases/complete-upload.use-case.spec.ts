import { describe, expect, it, vi } from 'vitest';
import type { StoredObjectHead } from '@shared/infrastructure/storage';
import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { AssetStatus } from '../../domain/asset-status';
import { UploadRejectedError } from '../../domain/errors/upload-rejected.error';
import { MediaAsset } from '../../domain/media-asset.entity';
import { fakeMediaAssetRepository, fakeObjectStorage } from '../../testing/media-port.doubles';
import { CompleteUploadUseCase } from './complete-upload.use-case';

const READY_TTL_SEC = 86_400;

const pendingAsset = MediaAsset.rehydrate({
  id: 'asset-1',
  storageKey: 'media/asset-1.png',
  contentType: 'image/png',
  sizeBytes: null,
  status: AssetStatus.PENDING,
  uploadedBy: 'admin-1',
  expiresAt: new Date(),
});

function build(head: StoredObjectHead, markReadyResult = true) {
  const markReady = vi.fn((_id: string, _sizeBytes: number, _expiresAt: Date) => Promise.resolve(markReadyResult));
  const useCase = new CompleteUploadUseCase(
    fakeMediaAssetRepository({ findById: () => Promise.resolve(pendingAsset), markReady }),
    fakeObjectStorage({ head: () => Promise.resolve(head) }),
    fakeConfigService({ 'media.maxBytes': 1024, 'media.readyTtlSec': READY_TTL_SEC }),
    fakePinoLogger(),
  );
  return { useCase, markReady };
}

describe('CompleteUploadUseCase', () => {
  it('marks the asset READY with the size the bucket reported and a fresh expiry', async () => {
    const { useCase, markReady } = build({ sizeBytes: 512, contentType: 'image/png' });
    const before = Date.now();

    await useCase.execute('asset-1');

    const [id, sizeBytes, expiresAt] = markReady.mock.calls[0];
    expect({ id, sizeBytes }).toEqual({ id: 'asset-1', sizeBytes: 512 });
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + READY_TTL_SEC * 1000);
  });

  // Unreachable end to end: the bucket refuses a PUT whose type differs from the signed one.
  it('rejects an object whose stored type differs from the signed one', async () => {
    const { useCase, markReady } = build({ sizeBytes: 10, contentType: 'image/jpeg' });

    await expect(useCase.execute('asset-1')).rejects.toBeInstanceOf(UploadRejectedError);
    expect(markReady).not.toHaveBeenCalled();
  });

  it('rejects when the asset changed state before it could be marked READY', async () => {
    const { useCase } = build({ sizeBytes: 10, contentType: 'image/png' }, false);

    await expect(useCase.execute('asset-1')).rejects.toBeInstanceOf(UploadRejectedError);
  });
});
