import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { fakeCatalogSearch } from '../../testing/catalog-port.doubles';
import { SearchIndexBootstrap } from './search-index-bootstrap';

const bootstrapWith = (ensureIndex: () => Promise<void>): SearchIndexBootstrap =>
  new SearchIndexBootstrap(fakeCatalogSearch({ ensureIndex }), fakePinoLogger());

describe('SearchIndexBootstrap', () => {
  it('stops waiting on an engine that never answers', async () => {
    vi.useFakeTimers();
    try {
      const booting = bootstrapWith(() => new Promise<void>(() => undefined)).onModuleInit();
      await vi.advanceTimersByTimeAsync(5_000);

      await expect(booting).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the deadline timer once provisioning wins', async () => {
    vi.useFakeTimers();
    try {
      await bootstrapWith(() => Promise.resolve()).onModuleInit();

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
