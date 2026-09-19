import { EventEmitter } from 'node:events';
import type { RedisService } from '@jcool/platform/redis';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { RedisDurabilityCheck } from './redis-durability.check';

class FakeRedisClient extends EventEmitter {
  status = 'ready';
  policy = 'noeviction';
  aof = '1';

  info(): Promise<string> {
    return Promise.resolve(
      ['# Memory', `maxmemory_policy:${this.policy}`, '', '# Persistence', `aof_enabled:${this.aof}`, ''].join('\r\n'),
    );
  }
}

const check = (client: FakeRedisClient): RedisDurabilityCheck =>
  new RedisDurabilityCheck({ getClient: () => client } as unknown as RedisService, fakePinoLogger());

describe('RedisDurabilityCheck', () => {
  afterEach(() => vi.useRealTimers());

  it('boots against a Redis that neither evicts nor forgets', async () => {
    await expect(check(new FakeRedisClient()).onModuleInit()).resolves.toBeUndefined();
  });

  it('refuses a Redis that evicts keys under memory pressure', async () => {
    const client = new FakeRedisClient();
    client.policy = 'allkeys-lru';

    await expect(check(client).onModuleInit()).rejects.toThrow(/maxmemory-policy is allkeys-lru/);
  });

  it('refuses a Redis that loses its writes on restart', async () => {
    const client = new FakeRedisClient();
    client.aof = '0';

    await expect(check(client).onModuleInit()).rejects.toThrow(/appendonly/);
  });

  it('waits for a connection still being made', async () => {
    const client = new FakeRedisClient();
    client.status = 'connecting';
    const booting = check(client).onModuleInit();

    client.status = 'ready';
    client.emit('ready');

    await expect(booting).resolves.toBeUndefined();
  });

  it('refuses to boot when Redis is not reachable within ten seconds', async () => {
    vi.useFakeTimers();
    const client = new FakeRedisClient();
    client.status = 'connecting';
    const booting = check(client).onModuleInit();
    const outcome = expect(booting).rejects.toThrow(/10000ms/);

    await vi.advanceTimersByTimeAsync(10_000);

    await outcome;
    expect(client.listenerCount('ready')).toBe(0);
  });
});
