import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import { createLogSampler } from '@shared/observability/logging/log-sampler';
import { METRICS, type MetricsPort } from '@shared/observability/metrics/metrics.port';
import { withSpan } from '@shared/observability/tracing/tracer';
import { CacheService } from './cache.service';
import { SingleFlightLock } from './single-flight.lock';
import { computeHardTtlMs, isEnvelope, isFresh, makeEnvelope, type CacheEnvelope, type TtlPolicy } from './ttl-policy';

const POLL_INTERVAL_MS = 25;

const LOG_CONTEXT = 'SwrCache';
const LOG_SAMPLE_WINDOW_MS = 10_000;
const UNLABELLED = '(unlabelled)';

/**
 * `decode` must throw on a payload it does not recognise: the entry is then treated as absent and
 * overwritten by the next rebuild, instead of poisoning the key until its TTL runs out.
 */
export interface CacheCodec<T> {
  // Never called with an absent value: the read-through does not store one.
  encode(value: NonNullable<T>): unknown;
  decode(raw: unknown): T;
}

export interface SwrReadOptions<T> {
  policy?: TtlPolicy;
  codec?: CacheCodec<T>;
  /**
   * Names the shape of the key on the rebuild span, so rebuilds can be grouped by what is being
   * rebuilt. The key itself is on the span too, but it carries an id and a generation counter and
   * so groups nothing.
   */
  label?: string;
}

interface ResolvedOptions<T> {
  policy: TtlPolicy;
  codec?: CacheCodec<T>;
  label?: string;
}

/**
 * Three mechanisms, each covering what the others cannot: a single-flight lock so one expiring key
 * costs one rebuild rather than one per request, stale-while-revalidate so nobody waits on that
 * rebuild, and TTL jitter so keys written together do not expire together. Redis is never
 * load-bearing here either: any failure degrades to reading through to `rebuild`.
 */
@Injectable()
export class SwrCacheService {
  readonly defaultPolicy: TtlPolicy;
  private readonly shouldLog = createLogSampler(LOG_SAMPLE_WINDOW_MS);

  constructor(
    private readonly cache: CacheService,
    private readonly lock: SingleFlightLock,
    @Inject(METRICS) private readonly metrics: MetricsPort,
    config: ConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.defaultPolicy = {
      softTtlMs: config.getOrThrow<number>('cache.softTtlMs'),
      staleWindowMs: config.getOrThrow<number>('cache.staleWindowMs'),
      jitterMs: config.getOrThrow<number>('cache.jitterMs'),
      leaseMs: config.getOrThrow<number>('cache.leaseMs'),
      waitMs: config.getOrThrow<number>('cache.waitMs'),
    };
  }

  /**
   * `key` reaches logs and span attributes verbatim, so it must hold nothing unsafe to hand an
   * operator — a personal id, an email, a token. Callers keying per user hash that part first.
   */
  async readThroughSwr<T>(key: string, rebuild: () => Promise<T>, options: SwrReadOptions<T> = {}): Promise<T> {
    const resolved: ResolvedOptions<T> = {
      policy: options.policy ?? this.defaultPolicy,
      codec: options.codec,
      label: options.label,
    };

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
        return filled ? filled.data : await this.rebuildAndStore(key, rebuild, options, 'miss');
      } finally {
        await this.lock.release(lockKeyFor(key), attempt.token);
      }
    }

    this.metrics.recordCatalogCacheOperation('lock_wait');
    const filled = await this.waitForEnvelope(key, options);
    if (filled) {
      return filled.data;
    }
    // The holder is slower than the budget, or let the lock go without storing a value. Reading
    // through is the one case where the herd is not fully suppressed, hence its own count.
    this.metrics.recordCatalogCacheOperation('lock_timeout');
    // Sampled per key shape: a stampede times out every waiter at once, and one line each would
    // put its heaviest logging exactly where the cache is already failing to absorb load.
    if (this.shouldLog(options.label ?? UNLABELLED)) {
      this.logger.warn(
        {
          context: LOG_CONTEXT,
          key,
          label: options.label,
          waitMs: options.policy.waitMs,
          leaseMs: options.policy.leaseMs,
        },
        'cache rebuild lock timed out, reading through',
      );
    }
    return rebuild();
  }

  /**
   * Fire-and-forget by design — the caller already has an answer — so a failure here must leave the
   * stale entry in place rather than surface, and losing the lock is normal under load, not an error.
   */
  private refreshInBackground<T>(key: string, rebuild: () => Promise<T>, options: ResolvedOptions<T>): void {
    void this.refreshIfUncontended(key, rebuild, options).catch((caught: unknown) => {
      this.logger.warn(
        { context: LOG_CONTEXT, key, reason: reasonOf(caught) },
        'background cache rebuild failed, serving stale',
      );
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
        await this.rebuildAndStore(key, rebuild, options, 'hit_stale');
      }
    } finally {
      await this.lock.release(lockKeyFor(key), attempt.token);
    }
  }

  /**
   * `trigger` is the lookup outcome that caused this rebuild — a cold key, or one that went stale
   * under a reader. It is the difference between "the cache is not absorbing load" and "the cache
   * is refreshing itself while readers are served", which the rebuild count alone cannot tell.
   */
  private rebuildAndStore<T>(
    key: string,
    rebuild: () => Promise<T>,
    options: ResolvedOptions<T>,
    trigger: 'miss' | 'hit_stale',
  ): Promise<T> {
    // The source read is the expensive half of a cache lookup and the only half nothing else times:
    // the auto-instrumented pg span sits under it with no idea it is serving a rebuild.
    return withSpan('cache.rebuild', async (span) => {
      span.setAttributes({ 'cache.key': key, 'cache.result': trigger });
      if (options.label) {
        span.setAttribute('cache.key_template', options.label);
      }

      const startedAt = Date.now();
      const data = await rebuild();
      const rebuildMs = Date.now() - startedAt;
      span.setAttribute('cache.rebuild_ms', rebuildMs);
      this.metrics.observeCacheRebuild(rebuildMs / 1000);
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
          // A Redis that reads fine but refuses writes (out of memory, say) would otherwise look
          // like a permanent miss rate with no errors at all.
          this.metrics.recordCatalogCacheOperation('store_rejected');
        }
      } catch (caught) {
        // `encode` is the caller's code and may throw. The value is already answered from the
        // source, so failing to file it away must not turn a served read into a 500.
        this.logger.warn({ context: LOG_CONTEXT, key, reason: reasonOf(caught) }, 'cache store failed');
        this.metrics.recordCatalogCacheOperation('store_rejected');
      }
      return data;
    });
  }

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
      // can throw, a write can be refused — and then no amount of waiting produces a value, so the
      // lock disappearing is the signal to stop and read through.
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
        this.logger.warn({ context: LOG_CONTEXT, key, reason: reasonOf(caught) }, 'discarding undecodable cache entry');
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

function reasonOf(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}
