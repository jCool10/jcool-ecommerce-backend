import { describe, expect, it, vi } from 'vitest';
import type { DrizzleTx } from '@shared/infrastructure/database/drizzle.tokens';
import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { AssetTransitionError } from '../../domain/asset-state-machine';
import { AssetStatus } from '../../domain/asset-status';
import { MediaAssetNotFoundError } from '../../domain/errors/media-asset-not-found.error';
import { fakeMediaAssetRepository, fakeObjectStorage } from '../../testing/media-port.doubles';
import type { MediaAssetRepositoryPort } from '../ports/media-asset-repository.port';
import { MediaAssetUnavailableError } from '../public/media-facade.port';
import { MediaFacadeService } from './media-facade.service';

const TX = {} as DrizzleTx;

function build(repository: Partial<MediaAssetRepositoryPort> = {}) {
  const warn = vi.fn();
  const facade = new MediaFacadeService(
    fakeMediaAssetRepository(repository),
    fakeObjectStorage({ publicUrl: (key) => Promise.resolve(`https://cdn.example/${key}`) }),
    fakeConfigService({ 'media.readyTtlSec': 86_400 }),
    fakePinoLogger({ warn }),
  );
  return { facade, warn };
}

describe('MediaFacadeService', () => {
  it('resolves each distinct id with one query and leaves out ids that have no row', async () => {
    const findStorageKeys = vi.fn((ids: string[]) =>
      Promise.resolve(ids.filter((id) => id !== 'gone').map((id) => ({ id, storageKey: `media/${id}.png` }))),
    );
    const { facade } = build({ findStorageKeys });

    const urls = await facade.getPublicUrls(['a', 'b', 'a', 'gone']);
    await facade.getPublicUrls([]);

    expect(urls).toEqual(
      new Map([
        ['a', 'https://cdn.example/media/a.png'],
        ['b', 'https://cdn.example/media/b.png'],
      ]),
    );
    expect(findStorageKeys).toHaveBeenCalledExactlyOnceWith(['a', 'b', 'gone']);
  });

  it('lets a detach succeed when the asset row is already gone, and warns', async () => {
    const { facade, warn } = build({ detach: () => Promise.reject(new MediaAssetNotFoundError('a')) });

    await expect(facade.detach(TX, 'a')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledExactlyOnceWith({ assetId: 'a' }, expect.any(String));
  });

  it('reports a missing or unclaimable asset as unavailable and rethrows the rest', async () => {
    const attachFailingWith = (error: Error) => build({ attach: () => Promise.reject(error) }).facade.attach(TX, 'a');
    const detachFailingWith = (error: Error) => build({ detach: () => Promise.reject(error) }).facade.detach(TX, 'a');
    const unexpected = new Error('connection reset');

    await expect(attachFailingWith(new MediaAssetNotFoundError('a'))).rejects.toBeInstanceOf(
      MediaAssetUnavailableError,
    );
    await expect(
      attachFailingWith(new AssetTransitionError(AssetStatus.SWEEPING, AssetStatus.ATTACHED)),
    ).rejects.toBeInstanceOf(MediaAssetUnavailableError);
    await expect(
      detachFailingWith(new AssetTransitionError(AssetStatus.SWEEPING, AssetStatus.DETACHED)),
    ).rejects.toBeInstanceOf(MediaAssetUnavailableError);
    await expect(attachFailingWith(unexpected)).rejects.toBe(unexpected);
  });
});
