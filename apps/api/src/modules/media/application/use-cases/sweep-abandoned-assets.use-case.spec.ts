import { describe, expect, it, vi } from 'vitest';
import { fakeMetricsPort } from '@jcool/testing/fake-metrics-port';
import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { RetentionSweepRegistry } from '@jcool/platform/retention';
import type { ObjectStoragePort } from '@shared/infrastructure/storage';
import type { ClaimedAsset } from '../ports/media-asset-repository.port';
import { fakeMediaAssetRepository, fakeObjectStorage } from '../../testing/media-port.doubles';
import { SweepAbandonedAssetsUseCase } from './sweep-abandoned-assets.use-case';

function build(
  claimed: ClaimedAsset[],
  options: { rowRemoved?: (id: string) => boolean; deleteObject?: ObjectStoragePort['delete'] } = {},
) {
  const calls: string[] = [];
  const recordMediaBytesReclaimed = vi.fn();
  const useCase = new SweepAbandonedAssetsUseCase(
    fakeMediaAssetRepository({
      claimForSweep: () => Promise.resolve(claimed),
      deleteClaimed: (id) => {
        calls.push(`row:${id}`);
        return Promise.resolve(options.rowRemoved?.(id) ?? true);
      },
    }),
    fakeObjectStorage({
      delete:
        options.deleteObject ??
        ((key) => {
          calls.push(`object:${key}`);
          return Promise.resolve();
        }),
    }),
    fakeMetricsPort({ recordMediaBytesReclaimed }),
    fakeConfigService({ 'retention.sweepTimeoutMs': 60_000 }),
    new RetentionSweepRegistry(),
  );
  return { useCase, calls, recordMediaBytesReclaimed };
}

const claim = (id: string, sizeBytes: number | null = 100): ClaimedAsset => ({
  id,
  storageKey: `media/${id}.png`,
  sizeBytes,
});

describe('SweepAbandonedAssetsUseCase', () => {
  // A crash between the two leaves a SWEEPING row the next pass finds again. The other order
  // would leave bytes nothing points at.
  it('deletes each object before its row', async () => {
    const { useCase, calls } = build([claim('a'), claim('b')]);

    await expect(useCase.sweep(10)).resolves.toBe(2);
    expect(calls).toEqual(['object:media/a.png', 'row:a', 'object:media/b.png', 'row:b']);
  });

  it('counts bytes only for rows this pass removed, and 0 for an unknown size', async () => {
    const { useCase, recordMediaBytesReclaimed } = build([claim('a', 400), claim('b', 700), claim('c', null)], {
      rowRemoved: (id) => id !== 'b',
    });

    await expect(useCase.sweep(10)).resolves.toBe(2);
    expect(recordMediaBytesReclaimed.mock.calls).toEqual([[400], [0]]);
  });

  // The scheduler's failure line has no per-asset field, so the asset travels on the error.
  it('names the asset and storage key when an object delete fails', async () => {
    const { useCase } = build([claim('a')], { deleteObject: () => Promise.reject(new Error('bucket unreachable')) });

    await expect(useCase.sweep(10)).rejects.toMatchObject({
      message: 'media sweep failed on asset a (storageKey: media/a.png)',
      cause: expect.objectContaining({ message: 'bucket unreachable' }) as unknown,
    });
  });
});
