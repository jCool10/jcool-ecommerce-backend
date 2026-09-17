import { fakePinoLogger } from '@shared/testing/fake-pino-logger';
import type { CatalogSearchPort } from '../../application/ports';
import { SearchIndexBootstrap } from './search-index-bootstrap';

const bootstrapWith = (ensureIndex: () => Promise<void>): SearchIndexBootstrap =>
  new SearchIndexBootstrap(searchPort(ensureIndex), fakePinoLogger());

function searchPort(ensureIndex: () => Promise<void>): CatalogSearchPort {
  return {
    ensureIndex,
    resetIndex: () => Promise.resolve(),
    bulkIndex: () => Promise.resolve(),
    indexProduct: () => Promise.resolve(),
    deleteProduct: () => Promise.resolve(),
    search: () => Promise.resolve({ items: [], total: 0 }),
  };
}

describe('SearchIndexBootstrap', () => {
  it('applies the index settings at boot', async () => {
    const ensureIndex = vi.fn().mockResolvedValue(undefined);

    await bootstrapWith(ensureIndex).onModuleInit();

    expect(ensureIndex).toHaveBeenCalledTimes(1);
  });

  it('boots anyway when the engine rejects', async () => {
    const ensureIndex = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED'));

    await expect(bootstrapWith(ensureIndex).onModuleInit()).resolves.toBeUndefined();
  });

  it('stops waiting on an engine that never answers', async () => {
    vi.useFakeTimers();
    try {
      const bootstrap = bootstrapWith(() => new Promise<void>(() => undefined));

      const booting = bootstrap.onModuleInit();
      await vi.advanceTimersByTimeAsync(5_000);

      await expect(booting).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not leave the deadline timer pending once provisioning wins', async () => {
    vi.useFakeTimers();
    try {
      await bootstrapWith(() => Promise.resolve()).onModuleInit();

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
