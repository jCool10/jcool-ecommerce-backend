import type { ConfigService } from '@nestjs/config';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DrizzleTx } from '@shared/infrastructure/database/drizzle.tokens';
import type { ObjectStoragePort } from '@shared/infrastructure/storage';
import { AssetTransitionError } from '../../domain/asset-state-machine';
import { AssetStatus } from '../../domain/asset-status';
import { MediaAssetNotFoundError } from '../../domain/errors/media-asset-not-found.error';
import type { MediaAssetRepositoryPort } from '../ports/media-asset-repository.port';
import { MediaAssetUnavailableError } from '../public/media-facade.port';
import { MediaFacadeService } from './media-facade.service';

const READY_TTL_SEC = 86_400;
const TX = {} as DrizzleTx;

function build() {
  const findStorageKeys = vi.fn((ids: string[]) =>
    Promise.resolve(ids.map((id) => ({ id, storageKey: `media/${id}.png` }))),
  );
  const attach = vi.fn((_tx: DrizzleTx, _id: string) => Promise.resolve());
  const detach = vi.fn((_tx: DrizzleTx, _id: string, _expiresAt: Date) => Promise.resolve());
  const publicUrl = vi.fn((key: string) => Promise.resolve(`https://cdn.example/${key}`));

  const config = { getOrThrow: () => READY_TTL_SEC } as unknown as ConfigService;
  const facade = new MediaFacadeService(
    { findStorageKeys, attach, detach } as unknown as MediaAssetRepositoryPort,
    { publicUrl } as unknown as ObjectStoragePort,
    config,
  );
  return { facade, findStorageKeys, attach, detach };
}

describe('MediaFacadeService', () => {
  let ctx: ReturnType<typeof build>;

  beforeEach(() => {
    ctx = build();
  });

  it('resolves a page of ids in one query, deduped', async () => {
    const urls = await ctx.facade.getPublicUrls(['a', 'b', 'a']);

    expect(ctx.findStorageKeys).toHaveBeenCalledExactlyOnceWith(['a', 'b']);
    expect(urls.get('a')).toBe('https://cdn.example/media/a.png');
    expect(urls.size).toBe(2);
  });

  it('costs no round trip for a product with no images', async () => {
    await expect(ctx.facade.getPublicUrls([])).resolves.toEqual(new Map());
    expect(ctx.findStorageKeys).not.toHaveBeenCalled();
  });

  it('leaves an id with no row out of the map rather than null-filling it', async () => {
    ctx.findStorageKeys.mockResolvedValue([{ id: 'a', storageKey: 'media/a.png' }]);

    const urls = await ctx.facade.getPublicUrls(['a', 'gone']);

    expect([...urls.keys()]).toEqual(['a']);
  });

  it('gives a detached asset an expiry, so the sweep can find it again', async () => {
    const before = Date.now();
    await ctx.facade.detach(TX, 'a');

    const [, , expiresAt] = ctx.detach.mock.calls[0];
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + READY_TTL_SEC * 1000);
  });

  it('accepts a give-back of an asset whose row is gone, so the caller can drop the dangling link', async () => {
    ctx.detach.mockRejectedValue(new MediaAssetNotFoundError('a'));

    await expect(ctx.facade.detach(TX, 'a')).resolves.toBeUndefined();
  });

  it('refuses a give-back the state machine rejects', async () => {
    ctx.detach.mockRejectedValue(new AssetTransitionError(AssetStatus.SWEEPING, AssetStatus.DETACHED));

    await expect(ctx.facade.detach(TX, 'a')).rejects.toBeInstanceOf(MediaAssetUnavailableError);
  });

  it.each([
    ['a missing asset', new MediaAssetNotFoundError('a')],
    ['an asset the sweep already claimed', new AssetTransitionError(AssetStatus.SWEEPING, AssetStatus.ATTACHED)],
  ])('translates %s into one error type a caller can map to 409', async (_case, error) => {
    ctx.attach.mockRejectedValue(error);

    await expect(ctx.facade.attach(TX, 'a')).rejects.toBeInstanceOf(MediaAssetUnavailableError);
  });

  it('lets an unexpected failure through untranslated', async () => {
    ctx.attach.mockRejectedValue(new Error('connection reset'));

    await expect(ctx.facade.attach(TX, 'a')).rejects.toThrow('connection reset');
  });
});
