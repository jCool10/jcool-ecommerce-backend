import { fakeMetricsPort } from '@jcool/testing/fake-metrics-port';
import { redisServiceWith } from '@shared/testing/redis-service.double';
import { RedisSessionEpochReader } from './redis-session-state.readers';

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
});
