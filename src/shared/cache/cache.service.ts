import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { RedisService } from '@shared/infrastructure/redis';

const LOG_CONTEXT = 'CacheService';

/** Outcome of one cache read. `miss` and `error` are kept apart because a cold key and an unreachable Redis are different incidents — folding them together hides an outage behind a plausible-looking miss rate. */
export type CacheRead<T> = { status: 'hit'; value: T } | { status: 'miss' } | { status: 'error' };

/**
 * Fail-open JSON cache over the shared Redis client: no operation throws, so an outage degrades a
 * read to a miss (caller falls through to the source of truth) instead of a 500. Failures are
 * reported in the return value rather than swallowed silently, so callers can still tell the
 * operator that the cache is down. `enableOfflineQueue: false` on the client makes those failures
 * immediate rather than a hang.
 */
@Injectable()
export class CacheService {
  constructor(
    private readonly redis: RedisService,
    private readonly logger: PinoLogger,
  ) {}

  async read<T>(key: string): Promise<CacheRead<T>> {
    let raw: string | null;
    try {
      raw = await this.redis.getClient().get(key);
    } catch (caught) {
      this.warn('read', key, caught);
      return { status: 'error' };
    }
    if (raw === null) {
      return { status: 'miss' };
    }
    try {
      return { status: 'hit', value: JSON.parse(raw) as T };
    } catch (caught) {
      // Undecodable payload, not an outage: report it as a plain miss so the caller refills.
      this.warn('read', key, caught);
      return { status: 'miss' };
    }
  }

  /** `false` means Redis rejected the write — the read still succeeded from the source, but the cache is not absorbing load. */
  async write(key: string, value: unknown, ttlSeconds: number): Promise<boolean> {
    return this.set(key, value, 'EX', ttlSeconds);
  }

  /** Same, at millisecond resolution — a jittered expiry needs finer granularity than a second to spread keys apart. */
  async writeMs(key: string, value: unknown, ttlMs: number): Promise<boolean> {
    return this.set(key, value, 'PX', ttlMs);
  }

  /**
   * Counter value, 0 when unset. `null` means Redis is unreachable — distinct from 0 so a caller
   * that mixes the counter into its keys can skip the cache entirely instead of reading and
   * writing a fabricated generation that a recovered Redis would then disagree with.
   */
  async readCounter(key: string): Promise<number | null> {
    try {
      const raw = await this.redis.getClient().get(key);
      const parsed = Number(raw);
      return Number.isInteger(parsed) ? parsed : 0;
    } catch (caught) {
      this.warn('readCounter', key, caught);
      return null;
    }
  }

  async bumpCounter(key: string): Promise<void> {
    try {
      await this.redis.getClient().incr(key);
    } catch (caught) {
      this.warn('bumpCounter', key, caught);
    }
  }

  private async set(key: string, value: unknown, unit: 'EX' | 'PX', ttl: number): Promise<boolean> {
    try {
      // Serialization is inside the guard on purpose: an unserializable payload (a cycle, a bigint)
      // must degrade to an uncached read like any other failure, not throw into the caller.
      const client = this.redis.getClient();
      const payload = JSON.stringify(value);
      // Branched rather than passed through: ioredis types the expiry flag as a literal per overload.
      await (unit === 'EX' ? client.set(key, payload, 'EX', ttl) : client.set(key, payload, 'PX', ttl));
      return true;
    } catch (caught) {
      this.warn('write', key, caught);
      return false;
    }
  }

  private warn(op: string, key: string, caught: unknown): void {
    const reason = caught instanceof Error ? caught.message : String(caught);
    this.logger.warn({ context: LOG_CONTEXT, op, key, reason }, 'cache operation failed');
  }
}
