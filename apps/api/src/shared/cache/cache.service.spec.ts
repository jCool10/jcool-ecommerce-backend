import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { describe, expect, it, vi } from 'vitest';
import { redisServiceWith } from '@shared/testing/redis-service.double';
import { CacheService } from './cache.service';

const DOWN = new Error("Stream isn't writeable and enableOfflineQueue options is false");

function build() {
  const client = { get: vi.fn(), set: vi.fn(), incr: vi.fn() };
  return { cache: new CacheService(redisServiceWith(client), fakePinoLogger()), client };
}

describe('CacheService', () => {
  it('tells a miss from an outage', async () => {
    const { cache, client } = build();
    client.get.mockResolvedValueOnce(null).mockRejectedValueOnce(DOWN);

    expect([await cache.read('k'), await cache.read('k')]).toEqual([{ status: 'miss' }, { status: 'error' }]);
  });

  it('reads an unparseable payload as a miss', async () => {
    const { cache, client } = build();
    client.get.mockResolvedValue('{not json');

    await expect(cache.read('k')).resolves.toEqual({ status: 'miss' });
  });

  // The shared instance runs `noeviction`: full, it refuses writes and keeps answering reads.
  it('reports a write that could not land as failed instead of throwing', async () => {
    const { cache, client } = build();
    client.set
      .mockRejectedValueOnce(DOWN)
      .mockRejectedValueOnce(new Error("OOM command not allowed when used memory > 'maxmemory'."));

    expect([
      await cache.write('k', { a: 1 }, 60),
      await cache.writeMs('k', { a: 1 }, 60_000),
      await cache.write('k', { total: 1n }, 60),
    ]).toEqual([false, false, false]);
  });

  // NaN would poison every key built from the generation.
  it('reads an unset or corrupt counter as generation 0', async () => {
    const { cache, client } = build();
    client.get.mockResolvedValueOnce(null).mockResolvedValueOnce('corrupted');

    expect([await cache.readCounter('k'), await cache.readCounter('k')]).toEqual([0, 0]);
  });

  it('reads a counter as null while Redis is down', async () => {
    const { cache, client } = build();
    client.get.mockRejectedValue(DOWN);

    await expect(cache.readCounter('k')).resolves.toBeNull();
  });

  it('swallows a failed increment', async () => {
    const { cache, client } = build();
    client.incr.mockRejectedValue(DOWN);

    await expect(cache.bumpCounter('k')).resolves.toBeUndefined();
  });
});
