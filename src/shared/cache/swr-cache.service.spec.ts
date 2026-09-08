import type { ConfigService } from '@nestjs/config';
import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { PinoLogger } from 'nestjs-pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MetricsPort } from '@shared/observability/metrics/metrics.port';
import type { CacheService } from './cache.service';
import type { SingleFlightLock } from './single-flight.lock';
import { SwrCacheService } from './swr-cache.service';
import { makeEnvelope, type TtlPolicy } from './ttl-policy';

// Short windows: the wait path polls for real, so a 500ms production budget would be 500ms of test.
const POLICY: TtlPolicy = { softTtlMs: 60_000, staleWindowMs: 30_000, jitterMs: 0, leaseMs: 5_000, waitMs: 80 };

const CONFIG_VALUES: Record<string, number> = {
  'cache.softTtlMs': 1_000,
  'cache.staleWindowMs': 2_000,
  'cache.jitterMs': 3_000,
  'cache.leaseMs': 4_000,
  'cache.waitMs': 5_000,
};

function build() {
  const cache = { read: vi.fn(), write: vi.fn(), writeMs: vi.fn().mockResolvedValue(true) };
  const lock = {
    acquire: vi.fn(),
    isHeld: vi.fn().mockResolvedValue(true),
    release: vi.fn().mockResolvedValue(undefined),
  };
  const metrics = { recordCatalogCacheOperation: vi.fn(), observeCacheRebuild: vi.fn() };
  const config = { getOrThrow: (key: string) => CONFIG_VALUES[key] };
  const logger = { warn: vi.fn() };
  const swr = new SwrCacheService(
    cache as unknown as CacheService,
    lock as unknown as SingleFlightLock,
    metrics as unknown as MetricsPort,
    config as unknown as ConfigService,
    logger as unknown as PinoLogger,
  );
  return { swr, cache, lock, metrics, logger };
}

function opsOf(metrics: { recordCatalogCacheOperation: ReturnType<typeof vi.fn> }): string[] {
  return metrics.recordCatalogCacheOperation.mock.calls.map(([result]) => result as string);
}

function flushBackgroundWork(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

describe('SwrCacheService', () => {
  let ctx: ReturnType<typeof build>;

  beforeEach(() => {
    ctx = build();
  });

  it('reads its default policy from config', () => {
    expect(ctx.swr.defaultPolicy).toEqual({
      softTtlMs: 1_000,
      staleWindowMs: 2_000,
      jitterMs: 3_000,
      leaseMs: 4_000,
      waitMs: 5_000,
    });
  });

  describe('fresh hit', () => {
    it('serves the cached value without touching the lock or the source', async () => {
      ctx.cache.read.mockResolvedValue({ status: 'hit', value: makeEnvelope({ id: 'p1' }, POLICY) });
      const rebuild = vi.fn();

      await expect(ctx.swr.readThroughSwr('k', rebuild, { policy: POLICY })).resolves.toEqual({ id: 'p1' });
      expect(rebuild).not.toHaveBeenCalled();
      expect(ctx.lock.acquire).not.toHaveBeenCalled();
      expect(opsOf(ctx.metrics)).toEqual(['hit_fresh']);
    });
  });

  describe('stale hit', () => {
    it('answers from the stale value immediately and refreshes behind it', async () => {
      const stale = makeEnvelope({ id: 'p1' }, POLICY, Date.now() - POLICY.softTtlMs - 1);
      ctx.cache.read.mockResolvedValue({ status: 'hit', value: stale });
      ctx.lock.acquire.mockResolvedValue({ status: 'acquired', token: 't' });
      // Only resolved after the read has already answered: a caller that waited would deadlock here.
      let finishRebuild!: (value: { id: string }) => void;
      const pending = new Promise<{ id: string }>((resolve) => {
        finishRebuild = resolve;
      });
      const rebuild = vi.fn(() => pending);

      await expect(ctx.swr.readThroughSwr('k', rebuild, { policy: POLICY })).resolves.toEqual({ id: 'p1' });

      finishRebuild({ id: 'p1-new' });
      await flushBackgroundWork();
      expect(rebuild).toHaveBeenCalledTimes(1);
      expect(ctx.cache.writeMs).toHaveBeenCalledWith('k', expect.objectContaining({ data: { id: 'p1-new' } }), 90_000);
      expect(ctx.lock.release).toHaveBeenCalledWith('k:lock', 't');
    });

    it('skips the background refresh when another caller already holds the lock', async () => {
      const stale = makeEnvelope({ id: 'p1' }, POLICY, Date.now() - POLICY.softTtlMs - 1);
      ctx.cache.read.mockResolvedValue({ status: 'hit', value: stale });
      ctx.lock.acquire.mockResolvedValue({ status: 'held' });
      const rebuild = vi.fn();

      await ctx.swr.readThroughSwr('k', rebuild, { policy: POLICY });
      await flushBackgroundWork();

      expect(rebuild).not.toHaveBeenCalled();
      expect(opsOf(ctx.metrics)).toEqual(['hit_stale']);
    });

    it('keeps serving stale when the background refresh fails instead of surfacing the error', async () => {
      const stale = makeEnvelope({ id: 'p1' }, POLICY, Date.now() - POLICY.softTtlMs - 1);
      ctx.cache.read.mockResolvedValue({ status: 'hit', value: stale });
      ctx.lock.acquire.mockResolvedValue({ status: 'acquired', token: 't' });
      const rebuild = vi.fn().mockRejectedValue(new Error('postgres down'));

      await expect(ctx.swr.readThroughSwr('k', rebuild, { policy: POLICY })).resolves.toEqual({ id: 'p1' });
      await flushBackgroundWork();

      expect(ctx.cache.writeMs).not.toHaveBeenCalled();
      expect(ctx.lock.release).toHaveBeenCalledWith('k:lock', 't');
    });
  });

  describe('miss', () => {
    it('rebuilds under the lock, stores an envelope and reports the rebuild duration', async () => {
      ctx.cache.read.mockResolvedValue({ status: 'miss' });
      ctx.lock.acquire.mockResolvedValue({ status: 'acquired', token: 't' });
      const rebuild = vi.fn().mockResolvedValue({ id: 'p1' });

      await expect(ctx.swr.readThroughSwr('k', rebuild, { policy: POLICY })).resolves.toEqual({ id: 'p1' });
      expect(ctx.cache.writeMs).toHaveBeenCalledWith('k', expect.objectContaining({ data: { id: 'p1' } }), 90_000);
      expect(ctx.metrics.observeCacheRebuild).toHaveBeenCalledTimes(1);
      expect(opsOf(ctx.metrics)).toEqual(['miss', 'lock_acquired', 'rebuild']);
    });

    it('skips the rebuild when the previous holder filled the key between the read and the lock', async () => {
      ctx.cache.read
        .mockResolvedValueOnce({ status: 'miss' })
        .mockResolvedValue({ status: 'hit', value: makeEnvelope({ id: 'p1' }, POLICY) });
      ctx.lock.acquire.mockResolvedValue({ status: 'acquired', token: 't' });
      const rebuild = vi.fn();

      await expect(ctx.swr.readThroughSwr('k', rebuild, { policy: POLICY })).resolves.toEqual({ id: 'p1' });
      expect(rebuild).not.toHaveBeenCalled();
      expect(ctx.lock.release).toHaveBeenCalledWith('k:lock', 't');
      expect(opsOf(ctx.metrics)).toEqual(['miss', 'lock_acquired']);
    });

    it('releases the lock even when the rebuild throws, so the key is not wedged for a full lease', async () => {
      ctx.cache.read.mockResolvedValue({ status: 'miss' });
      ctx.lock.acquire.mockResolvedValue({ status: 'acquired', token: 't' });

      await expect(
        ctx.swr.readThroughSwr('k', () => Promise.reject(new Error('boom')), { policy: POLICY }),
      ).rejects.toThrow('boom');
      expect(ctx.lock.release).toHaveBeenCalledWith('k:lock', 't');
    });

    it('waits for the lock holder rather than querying the source itself', async () => {
      ctx.cache.read
        .mockResolvedValueOnce({ status: 'miss' })
        .mockResolvedValue({ status: 'hit', value: makeEnvelope({ id: 'p1' }, POLICY) });
      ctx.lock.acquire.mockResolvedValue({ status: 'held' });
      const rebuild = vi.fn();

      await expect(ctx.swr.readThroughSwr('k', rebuild, { policy: POLICY })).resolves.toEqual({ id: 'p1' });
      expect(rebuild).not.toHaveBeenCalled();
      expect(opsOf(ctx.metrics)).toEqual(['miss', 'lock_wait']);
    });

    it('reads through to the source when the holder never delivers within the wait budget', async () => {
      ctx.cache.read.mockResolvedValue({ status: 'miss' });
      ctx.lock.acquire.mockResolvedValue({ status: 'held' });
      const rebuild = vi.fn().mockResolvedValue({ id: 'p1' });

      await expect(ctx.swr.readThroughSwr('k', rebuild, { policy: POLICY })).resolves.toEqual({ id: 'p1' });
      expect(rebuild).toHaveBeenCalledTimes(1);
      expect(opsOf(ctx.metrics)).toEqual(['miss', 'lock_wait', 'lock_timeout']);
    });

    // A holder that stores nothing — an absent value, a rebuild that threw, a refused write — used
    // to pin every waiter for the whole budget before they each queried the source anyway.
    it('stops waiting the moment the holder lets the lock go without storing a value', async () => {
      ctx.cache.read.mockResolvedValue({ status: 'miss' });
      ctx.lock.acquire.mockResolvedValue({ status: 'held' });
      ctx.lock.isHeld.mockResolvedValue(false);
      const rebuild = vi.fn().mockResolvedValue({ id: 'p1' });

      const startedAt = Date.now();
      await expect(ctx.swr.readThroughSwr('k', rebuild, { policy: POLICY })).resolves.toEqual({ id: 'p1' });

      expect(Date.now() - startedAt).toBeLessThan(POLICY.waitMs);
      expect(opsOf(ctx.metrics)).toEqual(['miss', 'lock_wait', 'lock_timeout']);
    });
  });

  describe('Redis unreachable', () => {
    it('falls through to the source on a failed read without attempting the lock', async () => {
      ctx.cache.read.mockResolvedValue({ status: 'error' });
      const rebuild = vi.fn().mockResolvedValue({ id: 'p1' });

      await expect(ctx.swr.readThroughSwr('k', rebuild, { policy: POLICY })).resolves.toEqual({ id: 'p1' });
      expect(ctx.lock.acquire).not.toHaveBeenCalled();
      expect(opsOf(ctx.metrics)).toEqual(['error_fallthrough']);
    });

    it('falls through to the source when the lock itself cannot be reached', async () => {
      ctx.cache.read.mockResolvedValue({ status: 'miss' });
      ctx.lock.acquire.mockResolvedValue({ status: 'error' });
      const rebuild = vi.fn().mockResolvedValue({ id: 'p1' });

      await expect(ctx.swr.readThroughSwr('k', rebuild, { policy: POLICY })).resolves.toEqual({ id: 'p1' });
      // Exactly one outcome per lookup: the fall-through replaces the miss, it does not follow it.
      expect(opsOf(ctx.metrics)).toEqual(['error_fallthrough']);
    });
  });

  it('treats a payload written under an older shape as a miss rather than a permanently stale entry', async () => {
    ctx.cache.read.mockResolvedValue({ status: 'hit', value: { id: 'p1' } });
    ctx.lock.acquire.mockResolvedValue({ status: 'acquired', token: 't' });
    const rebuild = vi.fn().mockResolvedValue({ id: 'p1-rebuilt' });

    await expect(ctx.swr.readThroughSwr('k', rebuild, { policy: POLICY })).resolves.toEqual({ id: 'p1-rebuilt' });
    expect(opsOf(ctx.metrics)).toEqual(['miss', 'lock_acquired', 'rebuild']);
  });

  it('does not store an absent value, so an unknown key cannot fill the cache with tombstones', async () => {
    ctx.cache.read.mockResolvedValue({ status: 'miss' });
    ctx.lock.acquire.mockResolvedValue({ status: 'acquired', token: 't' });

    await expect(ctx.swr.readThroughSwr('k', () => Promise.resolve(null), { policy: POLICY })).resolves.toBeNull();

    expect(ctx.cache.writeMs).not.toHaveBeenCalled();
    expect(opsOf(ctx.metrics)).toEqual(['miss', 'lock_acquired', 'rebuild']);
  });

  it('reports a rejected store, so a Redis that reads but refuses writes is not a silent miss', async () => {
    ctx.cache.read.mockResolvedValue({ status: 'miss' });
    ctx.cache.writeMs.mockResolvedValue(false);
    ctx.lock.acquire.mockResolvedValue({ status: 'acquired', token: 't' });

    await ctx.swr.readThroughSwr('k', () => Promise.resolve({ id: 'p1' }), { policy: POLICY });

    expect(opsOf(ctx.metrics)).toEqual(['miss', 'lock_acquired', 'rebuild', 'store_rejected']);
  });

  describe('codec', () => {
    const codec = {
      encode: (value: { id: string }) => ({ wire: value.id }),
      decode: (raw: unknown): { id: string } => {
        const wire = (raw as { wire?: unknown }).wire;
        if (typeof wire !== 'string') {
          throw new TypeError('not a wire payload');
        }
        return { id: wire };
      },
    };

    it('stores the encoded payload, not the value the caller sees', async () => {
      ctx.cache.read.mockResolvedValue({ status: 'miss' });
      ctx.lock.acquire.mockResolvedValue({ status: 'acquired', token: 't' });

      const answer = await ctx.swr.readThroughSwr('k', () => Promise.resolve({ id: 'p1' }), { policy: POLICY, codec });

      expect(answer).toEqual({ id: 'p1' });
      expect(ctx.cache.writeMs).toHaveBeenCalledWith('k', expect.objectContaining({ data: { wire: 'p1' } }), 90_000);
    });

    it('decodes a stored payload back into the shape the caller expects', async () => {
      ctx.cache.read.mockResolvedValue({ status: 'hit', value: makeEnvelope({ wire: 'p1' }, POLICY) });

      await expect(ctx.swr.readThroughSwr('k', vi.fn(), { policy: POLICY, codec })).resolves.toEqual({ id: 'p1' });
      expect(opsOf(ctx.metrics)).toEqual(['hit_fresh']);
    });

    it('serves the read even when the codec cannot encode what the source returned', async () => {
      ctx.cache.read.mockResolvedValue({ status: 'miss' });
      ctx.lock.acquire.mockResolvedValue({ status: 'acquired', token: 't' });
      const unserializable = {
        encode: () => {
          throw new TypeError('circular structure');
        },
        decode: (raw: unknown) => raw as { id: string },
      };

      const answer = await ctx.swr.readThroughSwr('k', () => Promise.resolve({ id: 'p1' }), {
        policy: POLICY,
        codec: unserializable,
      });

      expect(answer).toEqual({ id: 'p1' });
      expect(opsOf(ctx.metrics)).toEqual(['miss', 'lock_acquired', 'rebuild', 'store_rejected']);
    });

    it('rebuilds over an entry the codec rejects instead of serving it until its TTL runs out', async () => {
      ctx.cache.read.mockResolvedValue({ status: 'hit', value: makeEnvelope({ legacy: 'p1' }, POLICY) });
      ctx.lock.acquire.mockResolvedValue({ status: 'acquired', token: 't' });

      const answer = await ctx.swr.readThroughSwr('k', () => Promise.resolve({ id: 'p2' }), { policy: POLICY, codec });

      expect(answer).toEqual({ id: 'p2' });
      expect(ctx.cache.writeMs).toHaveBeenCalledWith('k', expect.objectContaining({ data: { wire: 'p2' } }), 90_000);
      expect(opsOf(ctx.metrics)).toEqual(['miss', 'lock_acquired', 'rebuild']);
    });
  });
});

// A background refresh has no request to hang its work off, so the rebuild span is all there is.
describe('SwrCacheService tracing', () => {
  const exporter = new InMemorySpanExporter();
  let provider: BasicTracerProvider;

  beforeAll(() => {
    context.disable();
    trace.disable();
    provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    trace.setGlobalTracerProvider(provider);
  });

  afterAll(async () => {
    await provider.shutdown();
    context.disable();
    trace.disable();
  });

  beforeEach(() => exporter.reset());

  it('names what was rebuilt and why, so rebuilds group by key shape rather than by id', async () => {
    const ctx = build();
    ctx.cache.read.mockResolvedValue({ status: 'miss' });
    ctx.lock.acquire.mockResolvedValue({ status: 'acquired', token: 't' });

    await ctx.swr.readThroughSwr('catalog:v3:product:p1', () => Promise.resolve({ id: 'p1' }), {
      policy: POLICY,
      label: 'catalog.product_detail',
    });

    const spans = exporter.getFinishedSpans().filter((span) => span.name === 'cache.rebuild');
    expect(spans).toHaveLength(1);
    expect(spans[0].attributes).toMatchObject({
      'cache.key': 'catalog:v3:product:p1',
      'cache.key_template': 'catalog.product_detail',
      'cache.result': 'miss',
    });
    expect(spans[0].attributes['cache.rebuild_ms']).toEqual(expect.any(Number));
  });

  it('records a refresh behind a stale hit as stale, not as a miss', async () => {
    const ctx = build();
    ctx.cache.read.mockResolvedValue({
      status: 'hit',
      value: makeEnvelope({ id: 'p1' }, POLICY, Date.now() - POLICY.softTtlMs - 1),
    });
    ctx.lock.acquire.mockResolvedValue({ status: 'acquired', token: 't' });

    await ctx.swr.readThroughSwr('k', () => Promise.resolve({ id: 'p1-new' }), { policy: POLICY });
    await flushBackgroundWork();

    const spans = exporter.getFinishedSpans().filter((span) => span.name === 'cache.rebuild');
    expect(spans).toHaveLength(1);
    expect(spans[0].attributes).toMatchObject({ 'cache.result': 'hit_stale' });
    expect(spans[0].attributes['cache.key_template']).toBeUndefined();
  });
});
