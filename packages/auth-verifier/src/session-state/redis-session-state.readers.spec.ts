import { ServiceUnavailableException } from '@nestjs/common';
import type { RedisService } from '@jcool/platform/redis';
import { fakeMetricsPort } from '@jcool/testing/fake-metrics-port';
import { SESSION_EPOCH_KEY_PREFIX, TOKEN_DENYLIST_KEY_PREFIX } from '../revocation-keys';
import { RedisSessionEpochReader, RedisTokenDenylistReader } from './redis-session-state.readers';

const redisServiceWith = (client: object): RedisService => ({ getClient: () => client }) as unknown as RedisService;

const USER_ID = '0199a3b2-7c4d-8e5f-9a0b-1c2d3e4f5a6b';

describe('RedisSessionEpochReader', () => {
  // NaN compares false against every epoch claim, so passing it on would accept revoked tokens.
  it('refuses a stored epoch that is not a whole number', async () => {
    for (const stored of ['', 'abc', '1.5', '-1']) {
      const redis = redisServiceWith({ get: () => Promise.resolve(stored) });
      const reader = new RedisSessionEpochReader(redis, { sessionEpoch: vi.fn() }, fakeMetricsPort());

      await expect(reader.current(USER_ID), JSON.stringify(stored)).rejects.toThrow(/epoch/);
    }
  });

  it('answers from Redis without asking the user-service', async () => {
    const get = vi.fn().mockResolvedValue('7');
    const userService = { sessionEpoch: vi.fn() };
    const metrics = fakeMetricsPort();
    const reader = new RedisSessionEpochReader(redisServiceWith({ get }), userService, metrics);

    await expect(reader.current(USER_ID)).resolves.toBe(7);
    expect(get).toHaveBeenCalledWith(SESSION_EPOCH_KEY_PREFIX + USER_ID);
    expect(userService.sessionEpoch).not.toHaveBeenCalled();
    expect(metrics.recordSessionEpochLookup).toHaveBeenCalledWith('hit');
  });

  it('reads through to the user-service on a miss', async () => {
    const userService = { sessionEpoch: vi.fn().mockResolvedValue(3) };
    const metrics = fakeMetricsPort();
    const reader = new RedisSessionEpochReader(
      redisServiceWith({ get: () => Promise.resolve(null) }),
      userService,
      metrics,
    );

    await expect(reader.current(USER_ID)).resolves.toBe(3);
    expect(userService.sessionEpoch).toHaveBeenCalledWith(USER_ID);
    expect(metrics.recordSessionEpochLookup).toHaveBeenCalledWith('miss');
  });

  it('turns an unreachable user-service into a 503, never an accepted token', async () => {
    const fault = new Error('connect ECONNREFUSED');
    const reader = new RedisSessionEpochReader(
      redisServiceWith({ get: () => Promise.resolve(null) }),
      { sessionEpoch: vi.fn().mockRejectedValue(fault) },
      fakeMetricsPort(),
    );

    const failure = await reader.current(USER_ID).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ServiceUnavailableException);
    expect((failure as Error).cause).toBe(fault);
  });
});

describe('RedisTokenDenylistReader', () => {
  it('denylists a jti whose key exists', async () => {
    const exists = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    const reader = new RedisTokenDenylistReader(redisServiceWith({ exists }));

    await expect(reader.isDenylisted('jti-1')).resolves.toBe(true);
    await expect(reader.isDenylisted('jti-2')).resolves.toBe(false);
    expect(exists).toHaveBeenNthCalledWith(1, TOKEN_DENYLIST_KEY_PREFIX + 'jti-1');
  });
});
