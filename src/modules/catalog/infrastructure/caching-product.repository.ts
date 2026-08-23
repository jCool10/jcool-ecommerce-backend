import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CacheService, type CacheRead } from '@shared/cache';
import { METRICS, type CacheResult, type MetricsPort } from '@shared/observability/metrics/metrics.port';
import type { Product } from '../domain/entities';
import type { FindManyActiveCriteria, FindManyActiveResult, ProductRepositoryPort } from '../application/ports';
import type { SkuView } from '../application/public/catalog-sku-query.port';
import { CATALOG_CACHE_VERSION_KEY, productDetailKey, productListKey } from './catalog-cache.keys';
import { DrizzleProductRepository } from './drizzle-product.repository';
import {
  fromProductSnapshot,
  toProductSnapshot,
  type ProductListSnapshot,
  type ProductSnapshot,
} from './product-cache.codec';

/**
 * Cache-aside decorator over the Drizzle read adapter, bound to `PRODUCT_REPOSITORY` so the
 * controller, use cases and domain never learn the cache exists. Postgres stays the source of
 * truth: any cache failure (or a snapshot that no longer decodes) is treated as a miss and the
 * read falls through, so Redis being down costs latency, not availability.
 *
 * Fixed TTL by design — stampede control (single-flight rebuild, TTL jitter,
 * stale-while-revalidate) is a separate concern and deliberately absent here.
 */
@Injectable()
export class CachingProductRepository implements ProductRepositoryPort {
  private readonly logger = new Logger(CachingProductRepository.name);
  private readonly ttlSeconds: number;

  constructor(
    private readonly source: DrizzleProductRepository,
    private readonly cache: CacheService,
    @Inject(METRICS) private readonly metrics: MetricsPort,
    config: ConfigService,
  ) {
    this.ttlSeconds = config.getOrThrow<number>('catalog.cacheTtlSec');
  }

  async findManyActive(criteria: FindManyActiveCriteria): Promise<FindManyActiveResult> {
    const version = await this.cache.readCounter(CATALOG_CACHE_VERSION_KEY);
    if (version === null) {
      this.metrics.recordCatalogCacheOperation('error');
      return this.source.findManyActive(criteria);
    }

    const key = productListKey(version, criteria);
    const read = await this.cache.read<ProductListSnapshot>(key);
    const cached = this.decode(read, (snapshot) => ({
      items: snapshot.items.map(fromProductSnapshot),
      total: snapshot.total,
    }));
    if (cached) {
      this.metrics.recordCatalogCacheOperation('hit');
      return cached;
    }

    const result = await this.source.findManyActive(criteria);
    const stored = await this.cache.write(
      key,
      { items: result.items.map(toProductSnapshot), total: result.total },
      this.ttlSeconds,
    );
    this.metrics.recordCatalogCacheOperation(classify(read, stored));
    return result;
  }

  async findActiveByIdOrSlug(idOrSlug: string): Promise<Product | null> {
    const version = await this.cache.readCounter(CATALOG_CACHE_VERSION_KEY);
    if (version === null) {
      this.metrics.recordCatalogCacheOperation('error');
      return this.source.findActiveByIdOrSlug(idOrSlug);
    }

    const key = productDetailKey(version, idOrSlug);
    const read = await this.cache.read<ProductSnapshot>(key);
    const cached = this.decode(read, fromProductSnapshot);
    if (cached) {
      this.metrics.recordCatalogCacheOperation('hit');
      return cached;
    }

    const product = await this.source.findActiveByIdOrSlug(idOrSlug);
    // A 404 is not cached: it is cheap to re-resolve, and negative entries would let an
    // unknown-slug flood evict live products.
    const stored = product ? await this.cache.write(key, toProductSnapshot(product), this.ttlSeconds) : true;
    this.metrics.recordCatalogCacheOperation(classify(read, stored));
    return product;
  }

  // Uncached passthrough: Cart reads this to price a line at add time, where a stale price or a
  // stale isActive is a wrong cart, not a slow one.
  findSkuView(skuId: string): Promise<SkuView | null> {
    return this.source.findSkuView(skuId);
  }

  // A snapshot written by an older payload shape (or a corrupted one) must not take down the read
  // path; drop it and let the caller refill.
  private decode<S, T>(read: CacheRead<S>, hydrate: (snapshot: S) => T): T | null {
    if (read.status !== 'hit') {
      return null;
    }
    try {
      return hydrate(read.value);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      this.logger.warn(`discarding undecodable catalog cache entry: ${message}`);
      return null;
    }
  }
}

/**
 * One label per lookup, decided only after the refill attempt. A rejected write counts as `error`
 * as much as a rejected read does — a Redis that reads fine but refuses writes (out of memory,
 * say) would otherwise report a permanent 100% miss rate and no errors at all.
 */
function classify(read: CacheRead<unknown>, stored: boolean): CacheResult {
  return read.status === 'error' || !stored ? 'error' : 'miss';
}
