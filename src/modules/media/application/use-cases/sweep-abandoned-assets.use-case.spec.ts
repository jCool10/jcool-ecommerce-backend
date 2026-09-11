import { describe, expect, it, vi } from 'vitest';
import { fakeMetricsPort } from '@shared/testing/fake-metrics-port';
import { fakeConfigService } from '@shared/testing/fake-config.service';
import type { RetentionSweepRegistry } from '@shared/retention';
import type { ClaimedAsset } from '../ports/media-asset-repository.port';
import { fakeMediaAssetRepository, fakeObjectStorage } from '../../testing/media-port.doubles';
import { SweepAbandonedAssetsUseCase } from './sweep-abandoned-assets.use-case';

const STALE_CLAIM_MS = 60_000;

function build(claimed: ClaimedAsset[], rowRemoved: (id: string) => boolean = () => true) {
  const calls: string[] = [];

  const claimForSweep = vi.fn((_now: Date, _staleClaimBefore: Date, _limit: number) => Promise.resolve(claimed));
  const deleteClaimed = vi.fn((id: string) => {
    calls.push(`row:${id}`);
    return Promise.resolve(rowRemoved(id));
  });
  const deleteObject = vi.fn((key: string) => {
    calls.push(`object:${key}`);
    return Promise.resolve();
  });
  const recordMediaBytesReclaimed = vi.fn();
  const register = vi.fn();
  const config = fakeConfigService({ 'retention.sweepTimeoutMs': STALE_CLAIM_MS });

  const useCase = new SweepAbandonedAssetsUseCase(
    fakeMediaAssetRepository({ claimForSweep, deleteClaimed }),
    fakeObjectStorage({ delete: deleteObject }),
    fakeMetricsPort({ recordMediaBytesReclaimed }),
    config,
    { register } as unknown as RetentionSweepRegistry,
  );
  return { useCase, calls, claimForSweep, recordMediaBytesReclaimed, register };
}

const claim = (id: string, sizeBytes: number | null = 100): ClaimedAsset => ({
  id,
  storageKey: `media/${id}.png`,
  sizeBytes,
});

describe('SweepAbandonedAssetsUseCase', () => {
  it('registers itself rather than starting a timer, so RETENTION_ENABLED governs it', () => {
    const ctx = build([]);
    ctx.useCase.onModuleInit();

    expect(ctx.register).toHaveBeenCalledWith(ctx.useCase);
  });

  it('deletes the object before the row — a crash between them leaves a re-scannable tombstone', async () => {
    const ctx = build([claim('a'), claim('b')]);

    await expect(ctx.useCase.sweep(10)).resolves.toBe(2);
    expect(ctx.calls).toEqual(['object:media/a.png', 'row:a', 'object:media/b.png', 'row:b']);
  });

  it('claims a batch in one statement, bounded by the batch size', async () => {
    const ctx = build([]);
    await ctx.useCase.sweep(25);

    const [now, staleClaimBefore, limit] = ctx.claimForSweep.mock.calls[0];
    expect(limit).toBe(25);
    expect(now.getTime() - staleClaimBefore.getTime()).toBe(STALE_CLAIM_MS);
  });

  it('counts reclaimed bytes only for rows this pass actually removed', async () => {
    const ctx = build([claim('a', 400), claim('b', 700)], (id) => id === 'a');

    await expect(ctx.useCase.sweep(10)).resolves.toBe(1);
    expect(ctx.recordMediaBytesReclaimed).toHaveBeenCalledExactlyOnceWith(400);
  });

  it('reports zero bytes for an upload that was never confirmed and so never measured', async () => {
    const ctx = build([claim('a', null)]);

    await ctx.useCase.sweep(10);
    expect(ctx.recordMediaBytesReclaimed).toHaveBeenCalledExactlyOnceWith(0);
  });
});
