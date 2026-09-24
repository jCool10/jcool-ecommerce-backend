import type { RedisService } from '@jcool/platform/redis';
import { RedisSessionEpochPublisher } from './redis-session-epoch.publisher';

// The script's max semantics need a real Redis; the session-epoch e2e suite runs it there.
class FakeRedisClient {
  evals = 0;
  failuresLeft = 0;
  stored = 0;

  eval(_script: string, _keys: number, _key: string, epoch: number): Promise<number> {
    this.evals++;
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
  it('retries a failed write, three attempts in all', async () => {
    const client = new FakeRedisClient();
    client.failuresLeft = 2;

    await expect(publisherOver(client).publish('u1', 4)).resolves.toBe(4);
    expect(client.evals).toBe(3);
  });

  it('gives up after the third failure, surfacing the last Redis error', async () => {
    const client = new FakeRedisClient();
    client.failuresLeft = 3;

    const rejection = (await publisherOver(client)
      .publish('u1', 4)
      .catch((error: unknown) => error)) as Error;

    expect(rejection.message).toBe('session epoch publish failed after 3 attempts');
    expect((rejection.cause as Error).message).toBe('Connection is closed.');
    expect(client.evals).toBe(3);
  });
});
