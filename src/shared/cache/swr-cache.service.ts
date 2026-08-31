import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { METRICS, type MetricsPort } from '@shared/observability/metrics/metrics.port';
import { CacheService } from './cache.service';
import { SingleFlightLock } from './single-flight.lock';
import { computeHardTtlMs, isEnvelope, isFresh, makeEnvelope, type CacheEnvelope, type TtlPolicy } from './ttl-policy';

const POLL_INTERVAL_MS = 25;

/**
 * Stampede-protected read-through cache. Three mechanisms, each covering what the others cannot:
 * a single-flight lock so one expiring key costs one rebuild rather than one per request,
 * stale-while-revalidate so nobody waits on that rebuild, and TTL jitter so keys written together
 * do not expire together. Layered over the plain cache-aside path, which stays as it is.
 *
 * Redis is never load-bearing here either: any failure degrades to reading through to `rebuild`.
 */
@Injectable()
export class SwrCacheService {
  private readonly logger = new Logger(SwrCacheService.name);
  readonly defaultPolicy: TtlPolicy;

  constructor(
    private readonly cache: CacheService,
    private readonly lock: SingleFlightLock,
    @Inject(METRICS) private readonly metrics: MetricsPort,
    config: ConfigService,
  ) {
    this.defaultPolicy = {
      softTtlMs: config.getOrThrow<number>('cache.softTtlMs'),
      staleWindowMs: config.getOrThrow<number>('cache.staleWindowMs'),
      jitterMs: config.getOrThrow<number>('cache.jitterMs'),
      leaseMs: config.getOrThrow<number>('cache.leaseMs'),
      waitMs: config.getOrThrow<number>('cache.waitMs'),
    };
  }

  async readThroughSwr<T>(key: string, rebuild: () => Promise<T>, policy: TtlPolicy = this.defaultPolicy): Promise<T> {
    const read = await this.cache.read<unknown>(key);
    if (read.status === 'error') {
      // Redis is unreachable, so the lock would be too: skip the single-flight dance entirely.
      this.metrics.recordCatalogCacheOperation('error_fallthrough');
      return rebuild();
    }

    const envelope = read.status === 'hit' && isEnvelope<T>(read.value) ? read.value : null;
    if (envelope && isFresh(envelope)) {
      this.metrics.recordCatalogCacheOperation('hit_fresh');
      return envelope.data;
    }
    if (envelope) {
      this.metrics.recordCatalogCacheOperation('hit_stale');
      this.refreshInBackground(key, rebuild, policy);
      return envelope.data;
    }

    return this.rebuildSingleFlight(key, rebuild, policy);
  }

  private async rebuildSingleFlight<T>(key: string, rebuild: () => Promise<T>, policy: TtlPolicy): Promise<T> {
    const attempt = await this.lock.acquire(lockKeyFor(key), policy.leaseMs);
    if (attempt.status === 'error') {
      this.metrics.recordCatalogCacheOperation('error_fallthrough');
      return rebuild();
    }

    // Recorded here rather than at the read, so exactly one of hit_fresh/hit_stale/miss/
    // error_fallthrough is counted per lookup and a hit ratio stays a ratio.
    this.metrics.recordCatalogCacheOperation('miss');

    if (attempt.status === 'acquired') {
      this.metrics.recordCatalogCacheOperation('lock_acquired');
      try {
        const filled = await this.readFreshEnvelope<T>(key);
        // The previous holder finished between this caller's read and its acquire: the lock is free
        // because the value is already there. Rebuilding again is the herd this whole class prevents.
        return filled ? filled.data : await this.rebuildAndStore(key, rebuild, policy);
      } finally {
        await this.lock.release(lockKeyFor(key), attempt.token);
      }
    }

    this.metrics.recordCatalogCacheOperation('lock_wait');
    const filled = await this.waitForEnvelope<T>(key, policy.waitMs);
    if (filled) {
      return filled.data;
    }
    // The holder is slower than the wait budget (or died before writing). Reading through is the
    // one case where the herd is not fully suppressed, which is why it is counted separately.
    this.metrics.recordCatalogCacheOperation('lock_timeout');
    return rebuild();
  }

  /**
   * Refresh behind a stale hit. Fire-and-forget by design — the caller already has an answer — so a
   * failure here must leave the stale entry in place rather than surface, and losing the lock is
   * the normal outcome under load, not an error.
   */
  private refreshInBackground<T>(key: string, rebuild: () => Promise<T>, policy: TtlPolicy): void {
    void this.refreshIfUncontended(key, rebuild, policy).catch((caught: unknown) => {
      const message = caught instanceof Error ? caught.message : String(caught);
      this.logger.warn(`background cache rebuild failed for "${key}", serving stale: ${message}`);
    });
  }

  private async refreshIfUncontended<T>(key: string, rebuild: () => Promise<T>, policy: TtlPolicy): Promise<void> {
    const attempt = await this.lock.acquire(lockKeyFor(key), policy.leaseMs);
    if (attempt.status !== 'acquired') {
      return;
    }
    this.metrics.recordCatalogCacheOperation('lock_acquired');
    try {
      if (!(await this.readFreshEnvelope(key))) {
        await this.rebuildAndStore(key, rebuild, policy);
      }
    } finally {
      await this.lock.release(lockKeyFor(key), attempt.token);
    }
  }

  private async rebuildAndStore<T>(key: string, rebuild: () => Promise<T>, policy: TtlPolicy): Promise<T> {
    const startedAt = Date.now();
    const data = await rebuild();
    this.metrics.observeCacheRebuild((Date.now() - startedAt) / 1000);
    this.metrics.recordCatalogCacheOperation('rebuild');
    await this.cache.writeMs(key, makeEnvelope(data, policy), computeHardTtlMs(policy));
    return data;
  }

  /** A value that is present and still fresh, or null — used to skip a rebuild the winner already did. */
  private async readFreshEnvelope<T>(key: string): Promise<CacheEnvelope<T> | null> {
    const read = await this.cache.read<unknown>(key);
    if (read.status !== 'hit' || !isEnvelope<T>(read.value) || !isFresh(read.value)) {
      return null;
    }
    return read.value;
  }

  // Reads before it sleeps: the holder may have written between this caller's own read and its
  // failed acquire, and a waiter should never pay a poll interval for a value already there.
  private async waitForEnvelope<T>(key: string, waitMs: number): Promise<CacheEnvelope<T> | null> {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const read = await this.cache.read<unknown>(key);
      if (read.status === 'error') {
        return null;
      }
      if (read.status === 'hit' && isEnvelope<T>(read.value)) {
        return read.value;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return null;
      }
      await sleep(Math.min(POLL_INTERVAL_MS, remaining));
    }
  }
}

// Namespaced off the data key so the lock expires and is scanned independently of the value it guards.
function lockKeyFor(key: string): string {
  return `${key}:lock`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
