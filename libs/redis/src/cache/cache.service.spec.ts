import type { Redis } from 'ioredis';
import type { PinoLogger } from 'nestjs-pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RedisService } from '@shared/infrastructure/redis';
import { CacheService } from './cache.service';

const DOWN = new Error("Stream isn't writeable and enableOfflineQueue options is false");

function build() {
  const client = { get: vi.fn(), set: vi.fn(), incr: vi.fn() };
  const cache = new CacheService(
    { getClient: () => client as unknown as Redis } as unknown as RedisService,
    {
      warn: vi.fn(),
    } as unknown as PinoLogger,
  );
  return { cache, client };
}

describe('CacheService', () => {
  let ctx: ReturnType<typeof build>;

  beforeEach(() => {
    ctx = build();
  });

  describe('read', () => {
    it('parses a stored value', async () => {
      ctx.client.get.mockResolvedValue('{"a":1}');
      await expect(ctx.cache.read('k')).resolves.toEqual({ status: 'hit', value: { a: 1 } });
    });

    it('reports a miss for an unset key', async () => {
      ctx.client.get.mockResolvedValue(null);
      await expect(ctx.cache.read('k')).resolves.toEqual({ status: 'miss' });
    });

    it('reports an error instead of throwing when Redis is down', async () => {
      ctx.client.get.mockRejectedValue(DOWN);
      await expect(ctx.cache.read('k')).resolves.toEqual({ status: 'error' });
    });

    it('reports an unparseable payload as a miss, not an outage', async () => {
      ctx.client.get.mockResolvedValue('{not json');
      await expect(ctx.cache.read('k')).resolves.toEqual({ status: 'miss' });
    });
  });

  describe('write', () => {
    it('writes JSON under an expiry', async () => {
      await expect(ctx.cache.write('k', { a: 1 }, 60)).resolves.toBe(true);
      expect(ctx.client.set).toHaveBeenCalledWith('k', '{"a":1}', 'EX', 60);
    });

    it('reports a failed write instead of throwing — caching is never load-bearing', async () => {
      ctx.client.set.mockRejectedValue(DOWN);
      await expect(ctx.cache.write('k', { a: 1 }, 60)).resolves.toBe(false);
    });
  });

  describe('readCounter', () => {
    it('reads the current value', async () => {
      ctx.client.get.mockResolvedValue('7');
      await expect(ctx.cache.readCounter('k')).resolves.toBe(7);
    });

    it('reports 0 for an unset counter — a real generation, not an outage', async () => {
      ctx.client.get.mockResolvedValue(null);
      await expect(ctx.cache.readCounter('k')).resolves.toBe(0);
    });

    it('reports 0 for a non-integer value rather than poisoning keys with NaN', async () => {
      ctx.client.get.mockResolvedValue('corrupted');
      await expect(ctx.cache.readCounter('k')).resolves.toBe(0);
    });

    it('reports null when Redis is down, so callers can tell an outage from generation 0', async () => {
      ctx.client.get.mockRejectedValue(DOWN);
      await expect(ctx.cache.readCounter('k')).resolves.toBeNull();
    });
  });

  describe('bumpCounter', () => {
    it('increments', async () => {
      await ctx.cache.bumpCounter('k');
      expect(ctx.client.incr).toHaveBeenCalledWith('k');
    });

    it('swallows a failed increment', async () => {
      ctx.client.incr.mockRejectedValue(DOWN);
      await expect(ctx.cache.bumpCounter('k')).resolves.toBeUndefined();
    });
  });
});
