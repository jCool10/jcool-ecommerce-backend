import type { RedisService } from '@jcool/platform/redis';
import { useFakeClock } from '@jcool/testing/fake-clock';
import { RedisTokenDenylist } from './redis-token-denylist';

const NOW = new Date('2026-01-01T00:00:00.000Z');

class FakeRedisClient {
  readonly sets: Array<[key: string, value: string, mode: string, ttl: number]> = [];

  set(key: string, value: string, mode: string, ttl: number): Promise<'OK'> {
    this.sets.push([key, value, mode, ttl]);
    return Promise.resolve('OK');
  }
}

function denylistOver(client: FakeRedisClient): RedisTokenDenylist {
  return new RedisTokenDenylist({ getClient: () => client } as unknown as RedisService);
}

describe('RedisTokenDenylist', () => {
  useFakeClock(NOW);

  it('keeps a denylisted jti exactly as long as its token has left to live', async () => {
    const client = new FakeRedisClient();

    await denylistOver(client).denylist('jti-1', new Date(NOW.getTime() + 60_000));

    expect(client.sets).toEqual([['auth:denylist:jti-1', '1', 'PX', 60_000]]);
  });

  // Redis refuses a zero or negative PX, and that error would fail the logout.
  it('writes nothing for a token that has already expired', async () => {
    const client = new FakeRedisClient();

    await denylistOver(client).denylist('jti-1', NOW);

    expect(client.sets).toEqual([]);
  });
});
