import type { RedisService } from '@jcool/platform/redis';
import { RedisSessionEpochPublisher } from './redis-session-epoch.publisher';

// The script's max semantics need a real Redis; the session-epoch e2e suite runs it there.
class FakeRedisClient {
  readonly evals: Array<{ keys: number; key: string; epoch: number }> = [];
  failuresLeft = 0;
  stored = 0;

  eval(_script: string, keys: number, key: string, epoch: number): Promise<number> {
    this.evals.push({ keys, key, epoch });
    if (this.failuresLeft > 0) {
      this.failuresLeft--;
      return Promise.reject(new Error('Connection is closed.'));
    }
    this.stored = Math.max(this.stored, epoch);
    return Promise.resolve(this.stored);
  }
}

function publisherOver(client: FakeRedisClient): RedisSessionEpochPublisher {
  return new RedisSessionEpochPublisher({ getClient: () => client } as unknown as RedisService);
}

describe('RedisSessionEpochPublisher', () => {
  it("raises the user's epoch key and resolves to what is now published", async () => {
    const client = new FakeRedisClient();
    client.stored = 7;

    await expect(publisherOver(client).publish('u1', 3)).resolves.toBe(7);
    expect(client.evals).toEqual([{ keys: 1, key: 'auth:epoch:u1', epoch: 3 }]);
  });

  it('retries a failed write, three attempts in all', async () => {
    const client = new FakeRedisClient();
    client.failuresLeft = 2;

    await expect(publisherOver(client).publish('u1', 4)).resolves.toBe(4);
    expect(client.evals).toHaveLength(3);
  });

  it('gives up after the third failure, so the caller answers 5xx', async () => {
    const client = new FakeRedisClient();
    client.failuresLeft = 3;

    await expect(publisherOver(client).publish('u1', 4)).rejects.toThrow('Connection is closed.');
    expect(client.evals).toHaveLength(3);
  });
});
