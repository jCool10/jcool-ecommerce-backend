import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { METRICS, type MetricsPort } from '@shared/observability/metrics/metrics.port';
import { CacheService } from './cache.service';
import { SingleFlightLock } from './single-flight.lock';
import { computeHardTtlMs, isEnvelope, isFresh, makeEnvelope, type CacheEnvelope, type TtlPolicy } from './ttl-policy';

const POLL_INTERVAL_MS = 25;

/**
 * Translates between the value a caller works with and the JSON that survives a Redis round-trip.
 * `decode` must throw on a payload it does not recognise: the entry is then treated as absent and
 * overwritten by the next rebuild, instead of poisoning the key until its TTL runs out.
 */
export interface CacheCodec<T> {
  // Never called with an absent value: the read-through does not store one, and the type says so
  // rather than leaving each codec to hand-wave a branch it can never reach.
  encode(value: NonNullable<T>): unknown;
  decode(raw: unknown): T;
}

export interface SwrReadOptions<T> {
  policy?: TtlPolicy;
  codec?: CacheCodec<T>;
}

interface ResolvedOptions<T> {
  policy: TtlPolicy;
  codec?: CacheCodec<T>;
}

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

  async readThroughSwr<T>(key: string, rebuild: () => Promise<T>, options: SwrReadOptions<T> = {}): Promise<T> {
    const resolved: ResolvedOptions<T> = { policy: options.policy ?? this.defaultPolicy, codec: options.codec };

    const read = await this.cache.read<unknown>(key);
    if (read.status === 'error') {
      // Redis is unreachable, so the lock would be too: skip the single-flight dance entirely.
      this.metrics.recordCatalogCacheOperation('error_fallthrough');
      return rebuild();
    }

    const envelope = read.status === 'hit' ? this.toEnvelope<T>(key, read.value, resolved) : null;
    if (envelope && isFresh(envelope)) {
      this.metrics.recordCatalogCacheOperation('hit_fresh');
      return envelope.data;
    }
    if (envelope) {
      this.metrics.recordCatalogCacheOperation('hit_stale');
      this.refreshInBackground(key, rebuild, resolved);
      return envelope.data;
    }

    return this.rebuildSingleFlight(key, rebuild, resolved);
  }

  private async rebuildSingleFlight<T>(
    key: string,
    rebuild: () => Promise<T>,
    options: ResolvedOptions<T>,
  ): Promise<T> {
    const attempt = await this.lock.acquire(lockKeyFor(key), options.policy.leaseMs);
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
        const filled = await this.readFreshEnvelope(key, options);
        // The previous holder finished between this caller's read and its acquire: the lock is free
        // because the value is already there. Rebuilding again is the herd this whole class prevents.
        return filled ? filled.data : await this.rebuildAndStore(key, rebuild, options);
      } finally {
        await this.lock.release(lockKeyFor(key), attempt.token);
      }
    }

    this.metrics.recordCatalogCacheOperation('lock_wait');
    const filled = await this.waitForEnvelope(key, options);
    if (filled) {
      return filled.data;
    }
    // The wait ended with nothing: the holder is slower than the budget, or it let the lock go
    // without storing a value. Reading through is the one case where the herd is not fully
    // suppressed, which is why it is counted separately.
    this.metrics.recordCatalogCacheOperation('lock_timeout');
    return rebuild();
  }

  /**
   * Refresh behind a stale hit. Fire-and-forget by design — the caller already has an answer — so a
   * failure here must leave the stale entry in place rather than surface, and losing the lock is
   * the normal outcome under load, not an error.
   */
  private refreshInBackground<T>(key: string, rebuild: () => Promise<T>, options: ResolvedOptions<T>): void {
    void this.refreshIfUncontended(key, rebuild, options).catch((caught: unknown) => {
      const message = caught instanceof Error ? caught.message : String(caught);
      this.logger.warn(`background cache rebuild failed for "${key}", serving stale: ${message}`);
    });
  }

  private async refreshIfUncontended<T>(
    key: string,
    rebuild: () => Promise<T>,
    options: ResolvedOptions<T>,
  ): Promise<void> {
    const attempt = await this.lock.acquire(lockKeyFor(key), options.policy.leaseMs);
    if (attempt.status !== 'acquired') {
      return;
    }
    this.metrics.recordCatalogCacheOperation('lock_acquired');
    try {
      if (!(await this.readFreshEnvelope(key, options))) {
        await this.rebuildAndStore(key, rebuild, options);
      }
    } finally {
      await this.lock.release(lockKeyFor(key), attempt.token);
    }
  }

  private async rebuildAndStore<T>(key: string, rebuild: () => Promise<T>, options: ResolvedOptions<T>): Promise<T> {
    const startedAt = Date.now();
    const data = await rebuild();
    this.metrics.observeCacheRebuild((Date.now() - startedAt) / 1000);
    this.metrics.recordCatalogCacheOperation('rebuild');

    // An absent value is never stored. Negative caching is a per-domain call — a flood of unknown
    // ids would otherwise fill the keyspace with tombstones that evict live entries — so callers
    // that want it cache their own sentinel instead.
    if (data == null) {
      return data;
    }

    try {
      const payload = options.codec ? options.codec.encode(data) : data;
      const stored = await this.cache.writeMs(
        key,
        makeEnvelope(payload, options.policy),
        computeHardTtlMs(options.policy),
      );
      if (!stored) {
        // A Redis that reads fine but refuses writes (out of memory, say) would otherwise look like
        // a permanent miss rate with no errors at all.
        this.metrics.recordCatalogCacheOperation('store_rejected');
      }
    } catch (caught) {
      // `encode` is the caller's code and may throw. The value is already answered from the source,
      // so failing to file it away must not turn a served read into a 500.
      const message = caught instanceof Error ? caught.message : String(caught);
      this.logger.warn(`cache store failed for "${key}": ${message}`);
      this.metrics.recordCatalogCacheOperation('store_rejected');
    }
    return data;
  }

  /** A value that is present and still fresh, or null — used to skip a rebuild the winner already did. */
  private async readFreshEnvelope<T>(key: string, options: ResolvedOptions<T>): Promise<CacheEnvelope<T> | null> {
    const read = await this.cache.read<unknown>(key);
    if (read.status !== 'hit') {
      return null;
    }
    // Quiet: this re-read follows one that already reported any drift on this key, for this caller.
    const envelope = this.toEnvelope<T>(key, read.value, options, false);
    return envelope && isFresh(envelope) ? envelope : null;
  }

  // Reads before it sleeps: the holder may have written between this caller's own read and its
  // failed acquire, and a waiter should never pay a poll interval for a value already there.
  private async waitForEnvelope<T>(key: string, options: ResolvedOptions<T>): Promise<CacheEnvelope<T> | null> {
    const deadline = Date.now() + options.policy.waitMs;
    for (;;) {
      const read = await this.cache.read<unknown>(key);
      if (read.status === 'error') {
        return null;
      }
      if (read.status === 'hit') {
        // Present but unreadable is as final as an outage here: the holder wrote it, so waiting
        // longer cannot make it decode.
        return this.toEnvelope<T>(key, read.value, options);
      }
      // A holder can finish without storing anything — an absent value is never cached, a rebuild
      // can throw, a write can be refused — and then no amount of waiting produces a value. The
      // lock disappearing is the signal to stop and read through, which is what this caller would
      // have done at the deadline anyway.
      if (!(await this.lock.isHeld(lockKeyFor(key)))) {
        return null;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return null;
      }
      await sleep(Math.min(POLL_INTERVAL_MS, remaining));
    }
  }

  private toEnvelope<T>(
    key: string,
    value: unknown,
    options: ResolvedOptions<T>,
    warnOnDrift = true,
  ): CacheEnvelope<T> | null {
    if (!isEnvelope<unknown>(value)) {
      return null;
    }
    if (!options.codec) {
      return value as CacheEnvelope<T>;
    }
    try {
      return { data: options.codec.decode(value.data), freshUntil: value.freshUntil };
    } catch (caught) {
      if (warnOnDrift) {
        const message = caught instanceof Error ? caught.message : String(caught);
        this.logger.warn(`discarding undecodable cache entry "${key}": ${message}`);
      }
      return null;
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
