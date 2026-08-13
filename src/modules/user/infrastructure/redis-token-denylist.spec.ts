import type { RedisService } from '@shared/infrastructure/redis';
import { RedisTokenDenylist } from './redis-token-denylist';

// Minimal fake of the ioredis client surface the adapter touches (set/exists).
class FakeRedisClient {
  setCalls: Array<{ key: string; value: string; mode: string; ttl: number }> = [];
  existsReturn = 0;

  set(key: string, value: string, mode: string, ttl: number): Promise<'OK'> {
    this.setCalls.push({ key, value, mode, ttl });
    return Promise.resolve('OK');
  }
  exists(_key: string): Promise<number> {
    return Promise.resolve(this.existsReturn);
  }
}

function makeAdapter(client: FakeRedisClient): RedisTokenDenylist {
  const redis = { getClient: () => client } as unknown as RedisService;
  return new RedisTokenDenylist(redis);
}

describe('RedisTokenDenylist', () => {
  it('sets a prefixed key with a PX TTL equal to the token’s remaining life', async () => {
    const client = new FakeRedisClient();
    const adapter = makeAdapter(client);
    const expiresAt = new Date(Date.now() + 60_000); // ~60s ahead

    await adapter.denylist('jti-1', expiresAt);

    expect(client.setCalls).toHaveLength(1);
    const call = client.setCalls[0];
    expect(call.key).toBe('auth:denylist:jti-1');
    expect(call.value).toBe('1');
    expect(call.mode).toBe('PX');
    // Allow a small clock delta between building the Date and reading Date.now().
    expect(call.ttl).toBeGreaterThan(55_000);
    expect(call.ttl).toBeLessThanOrEqual(60_000);
  });

  it('is a no-op when the token has already expired (no negative TTL written)', async () => {
    const client = new FakeRedisClient();
    const adapter = makeAdapter(client);

    await adapter.denylist('jti-1', new Date(Date.now() - 1_000));

    expect(client.setCalls).toHaveLength(0);
  });

  it('reports denylisted when the key exists, live otherwise', async () => {
    const client = new FakeRedisClient();
    const adapter = makeAdapter(client);

    client.existsReturn = 1;
    await expect(adapter.isDenylisted('jti-1')).resolves.toBe(true);

    client.existsReturn = 0;
    await expect(adapter.isDenylisted('jti-1')).resolves.toBe(false);
  });
});
