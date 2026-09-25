import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { fakeCatalogSearch } from '../../testing/catalog-port.doubles';
import { SearchEngineError } from './search-engine-error';
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

  it('logs a refused provisioning by the engine error type', async () => {
    const warn = vi.fn();
    const refusal = new SearchEngineError('illegal_argument_exception', 400, 'mapper [name] cannot be changed');
    const bootstrap = new SearchIndexBootstrap(
      fakeCatalogSearch({ ensureIndex: () => Promise.reject(refusal) }),
      fakePinoLogger({ warn }),
    );

    await bootstrap.onModuleInit();

    expect(warn.mock.calls[0]?.[0]).toEqual({
      error: { type: 'illegal_argument_exception', statusCode: 400, message: 'mapper [name] cannot be changed' },
    });
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
