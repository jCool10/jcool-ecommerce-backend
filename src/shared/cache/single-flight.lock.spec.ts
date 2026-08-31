import type { Redis } from 'ioredis';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RedisService } from '@shared/infrastructure/redis';
import { SingleFlightLock } from './single-flight.lock';

const DOWN = new Error("Stream isn't writeable and enableOfflineQueue options is false");

function build() {
  const client = { set: vi.fn(), eval: vi.fn() };
  const lock = new SingleFlightLock({ getClient: () => client as unknown as Redis } as unknown as RedisService);
  return { lock, client };
}

describe('SingleFlightLock', () => {
  let ctx: ReturnType<typeof build>;

  beforeEach(() => {
    ctx = build();
  });

  describe('acquire', () => {
    it('takes the lock with a lease and a token, atomically', async () => {
      ctx.client.set.mockResolvedValue('OK');

      const attempt = await ctx.lock.acquire('k:lock', 5000);

      expect(attempt.status).toBe('acquired');
      expect(ctx.client.set).toHaveBeenCalledWith(
        'k:lock',
        attempt.status === 'acquired' ? attempt.token : '',
        'PX',
        5000,
        'NX',
      );
    });

    it('reports the lock as held when someone else has it', async () => {
      ctx.client.set.mockResolvedValue(null);
      await expect(ctx.lock.acquire('k:lock', 5000)).resolves.toEqual({ status: 'held' });
    });

    it('reports an outage separately from a held lock — waiting for a holder that cannot exist is wasted latency', async () => {
      ctx.client.set.mockRejectedValue(DOWN);
      await expect(ctx.lock.acquire('k:lock', 5000)).resolves.toEqual({ status: 'error' });
    });

    it('hands every acquire its own token', async () => {
      ctx.client.set.mockResolvedValue('OK');
      const first = await ctx.lock.acquire('k:lock', 5000);
      const second = await ctx.lock.acquire('k:lock', 5000);
      expect(first).not.toEqual(second);
    });
  });

  describe('release', () => {
    it('deletes only under a matching token, so an expired lease cannot drop the next holder', async () => {
      await ctx.lock.release('k:lock', 'token-1');

      const [script, keyCount, key, token] = ctx.client.eval.mock.calls[0] as [string, number, string, string];
      expect(script).toContain("redis.call('get', KEYS[1]) == ARGV[1]");
      expect(script).toContain("redis.call('del', KEYS[1])");
      expect([keyCount, key, token]).toEqual([1, 'k:lock', 'token-1']);
    });

    it('swallows a failed release — the lease expires on its own', async () => {
      ctx.client.eval.mockRejectedValue(DOWN);
      await expect(ctx.lock.release('k:lock', 'token-1')).resolves.toBeUndefined();
    });
  });
});
