import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { beforeAll, describe, expect, it } from 'vitest';
import { SingleFlightLock, SwrCacheService, type TtlPolicy } from '../../src/shared/cache';
import { RedisService } from '@jcool/platform/redis';
import { closeAppAfterAll } from '../setup/harness';
import { sleep } from '../setup/sleep';
import { createTestApp } from '../setup/test-app.factory';

const POLICY: TtlPolicy = { softTtlMs: 150, staleWindowMs: 10_000, jitterMs: 2_000, leaseMs: 5_000, waitMs: 3_000 };

describe('Cache single-flight lock and expiry jitter (integration, real Redis)', () => {
  let app: INestApplication;
  let swr: SwrCacheService;
  let lock: SingleFlightLock;
  let client: Redis;

  beforeAll(async () => {
    app = await createTestApp();
    swr = app.get(SwrCacheService);
    lock = app.get(SingleFlightLock);
    client = app.get(RedisService).getClient();
  });
  closeAppAfterAll(() => app);

  it('spreads the expiry of keys written together', async () => {
    const keys = Array.from({ length: 10 }, () => `swr:test:${randomUUID()}`);
    await Promise.all(
      keys.map((key) => swr.readThroughSwr(key, () => Promise.resolve({ id: key }), { policy: POLICY })),
    );

    const ttls = await Promise.all(keys.map((key) => client.pttl(key)));
    for (const ttl of ttls) {
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(POLICY.softTtlMs + POLICY.staleWindowMs + POLICY.jitterMs);
    }
    expect(new Set(ttls).size).toBeGreaterThan(1);
  });

  it('does not let a holder whose lease expired release the next holder', async () => {
    const lockKey = `swr:test:${randomUUID()}:lock`;

    const first = await lock.acquire(lockKey, 100);
    expect(first.status).toBe('acquired');
    await sleep(150);

    const second = await lock.acquire(lockKey, 5_000);
    expect(second.status).toBe('acquired');

    await lock.release(lockKey, first.status === 'acquired' ? first.token : '');

    expect(await client.get(lockKey)).toBe(second.status === 'acquired' ? second.token : '');
  });
});
