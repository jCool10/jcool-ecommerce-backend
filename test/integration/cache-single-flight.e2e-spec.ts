import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SingleFlightLock, SwrCacheService, type TtlPolicy } from '../../src/shared/cache';
import { RedisService } from '../../src/shared/infrastructure/redis';
import { withRedisDown } from '../setup/redis-outage';
import { createTestApp } from '../setup/test-app.factory';

// Real Redis, short windows so the stale path is reachable inside a test.
const POLICY: TtlPolicy = { softTtlMs: 150, staleWindowMs: 10_000, jitterMs: 2_000, leaseMs: 5_000, waitMs: 3_000 };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A source read that is slow enough for a herd to pile up behind it, and counts how often it ran. */
function countingSource(value: unknown, delayMs = 100) {
  let calls = 0;
  return {
    calls: () => calls,
    rebuild: async () => {
      calls += 1;
      await sleep(delayMs);
      return value;
    },
  };
}

describe('Cache stampede protection (integration, real Redis)', () => {
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

  afterAll(async () => {
    await app.close();
  });

  it('rebuilds a cold key exactly once for a herd of concurrent readers', async () => {
    const key = `swr:test:${randomUUID()}`;
    const source = countingSource({ id: 'p1' });

    const answers = await Promise.all(
      Array.from({ length: 20 }, () => swr.readThroughSwr(key, source.rebuild, { policy: POLICY })),
    );

    expect(source.calls()).toBe(1);
    expect(answers).toEqual(Array.from({ length: 20 }, () => ({ id: 'p1' })));
  });

  it('serves the stale value immediately once the fresh window closes, then refreshes behind it', async () => {
    const key = `swr:test:${randomUUID()}`;
    let version = 1;
    const rebuild = () => Promise.resolve({ version: version++ });

    expect(await swr.readThroughSwr(key, rebuild, { policy: POLICY })).toEqual({ version: 1 });
    await sleep(POLICY.softTtlMs + 20);

    // Answered from the stale entry — the refresh it triggers has not landed yet.
    expect(await swr.readThroughSwr(key, rebuild, { policy: POLICY })).toEqual({ version: 1 });

    // Polled on the stored entry rather than through the service: another read would itself trigger
    // a refresh, so the assertion would be racing the rebuilds it causes.
    await expect.poll(() => client.get(key), { timeout: 2_000 }).toContain('"version":2');
    expect(await swr.readThroughSwr(key, rebuild, { policy: POLICY })).toEqual({ version: 2 });
  });

  it('spreads the expiry of keys written together, so one wave cannot expire in one instant', async () => {
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

  it('releases only its own lock, so a holder whose lease expired cannot drop the next one', async () => {
    const lockKey = `swr:test:${randomUUID()}:lock`;

    const first = await lock.acquire(lockKey, 100);
    expect(first.status).toBe('acquired');
    await sleep(150); // the lease lapses mid-"rebuild"

    const second = await lock.acquire(lockKey, 5_000);
    expect(second.status).toBe('acquired');

    // The first holder finishes late and releases with its now-stale token.
    await lock.release(lockKey, first.status === 'acquired' ? first.token : '');

    expect(await client.get(lockKey)).toBe(second.status === 'acquired' ? second.token : '');
  });

  it('reads through to the source when Redis is unreachable, without failing the request', async () => {
    const key = `swr:test:${randomUUID()}`;
    const source = countingSource({ id: 'from-postgres' }, 0);

    await withRedisDown(app, async () => {
      await expect(swr.readThroughSwr(key, source.rebuild, { policy: POLICY })).resolves.toEqual({
        id: 'from-postgres',
      });
    });

    expect(source.calls()).toBe(1);
  });
});
