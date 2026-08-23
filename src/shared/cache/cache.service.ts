import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '@shared/infrastructure/redis';

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
  private readonly logger = new Logger(CacheService.name);

  constructor(private readonly redis: RedisService) {}

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
    try {
      await this.redis.getClient().set(key, JSON.stringify(value), 'EX', ttlSeconds);
      return true;
    } catch (caught) {
      this.warn('write', key, caught);
      return false;
    }
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

  private warn(op: string, key: string, caught: unknown): void {
    const message = caught instanceof Error ? caught.message : String(caught);
    this.logger.warn(`cache ${op} failed for "${key}": ${message}`);
  }
}
