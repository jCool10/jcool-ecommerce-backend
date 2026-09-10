import type { RedisService } from '@shared/infrastructure/redis';
import type { MetricsPort } from '@shared/observability/metrics/metrics.port';
import { RedisSessionEpochReader } from './redis-session-epoch.reader';

function makeReader(stored: string | null): {
  reader: RedisSessionEpochReader;
  misses: () => number;
  key: () => string;
} {
  let requestedKey = '';
  let misses = 0;
  const redis = {
    getClient: () => ({
      get: (key: string) => {
        requestedKey = key;
        return Promise.resolve(stored);
      },
    }),
  } as unknown as RedisService;
  const metrics = { recordAuthEpochProjectionMiss: () => void misses++ } as unknown as MetricsPort;
  return { reader: new RedisSessionEpochReader(redis, metrics), misses: () => misses, key: () => requestedKey };
}

describe('RedisSessionEpochReader', () => {
  it('reads the epoch under the shared auth:epoch: prefix', async () => {
    const { reader, key } = makeReader('7');
    await expect(reader.current('user-1')).resolves.toBe(7);
    expect(key()).toBe('auth:epoch:user-1');
  });

  it('returns 0 as an epoch, not as a miss — a fresh user has never been revoked', async () => {
    const { reader, misses } = makeReader('0');
    await expect(reader.current('user-1')).resolves.toBe(0);
    expect(misses()).toBe(0);
  });

  it('reports null and counts a miss when the projection holds nothing', async () => {
    const { reader, misses } = makeReader(null);
    await expect(reader.current('gone')).resolves.toBeNull();
    expect(misses()).toBe(1);
  });

  it('treats a non-numeric value as no projection rather than coercing it', async () => {
    const { reader } = makeReader('corrupted');
    await expect(reader.current('user-1')).resolves.toBeNull();
  });
});
