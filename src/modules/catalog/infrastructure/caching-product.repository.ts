import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CacheService, SwrCacheService, type CacheCodec, type TtlPolicy } from '@shared/cache';
import { METRICS, type MetricsPort } from '@shared/observability/metrics/metrics.port';
import type { Product } from '../domain/entities';
import type { FindManyActiveCriteria, FindManyActiveResult, ProductRepositoryPort } from '../application/ports';
import type { SkuView } from '../application/public/catalog-sku-query.port';
import { CATALOG_CACHE_VERSION_KEY, productDetailKey, productListKey } from './catalog-cache.keys';
import { DrizzleProductRepository } from './drizzle-product.repository';
import {
  fromProductListSnapshot,
  fromProductSnapshot,
  toProductListSnapshot,
  toProductSnapshot,
} from './product-cache.codec';

// A 404 is never cached: the read-through does not store an absent value, so an unknown-slug flood
// cannot fill Redis with tombstones that evict live products.
const DETAIL_CODEC: CacheCodec<Product | null> = {
  encode: toProductSnapshot,
  decode: fromProductSnapshot,
};

const LIST_CODEC: CacheCodec<FindManyActiveResult> = {
  encode: toProductListSnapshot,
  decode: fromProductListSnapshot,
};

/**
 * Stampede-protected read-through cache over the Drizzle read adapter, bound to `PRODUCT_REPOSITORY`
 * so the controller, use cases and domain never learn the cache exists. Postgres stays the source of
 * truth: any cache failure — an unreachable Redis, a snapshot that no longer decodes — falls through
 * to it, so Redis being down costs latency, not availability.
 */
@Injectable()
export class CachingProductRepository implements ProductRepositoryPort {
  private readonly policy: TtlPolicy;

  constructor(
    private readonly source: DrizzleProductRepository,
    private readonly cache: CacheService,
    private readonly swr: SwrCacheService,
    @Inject(METRICS) private readonly metrics: MetricsPort,
    config: ConfigService,
  ) {
    // Catalog decides how long its own entries count as fresh; the stale window, jitter and lock
    // bounds are process-wide and shared with every other stampede-protected read.
    this.policy = { ...swr.defaultPolicy, softTtlMs: config.getOrThrow<number>('catalog.cacheTtlSec') * 1000 };
  }

  async findManyActive(criteria: FindManyActiveCriteria): Promise<FindManyActiveResult> {
    const version = await this.cache.readCounter(CATALOG_CACHE_VERSION_KEY);
    if (version === null) {
      this.metrics.recordCatalogCacheOperation('error');
      return this.source.findManyActive(criteria);
    }

    return this.swr.readThroughSwr(productListKey(version, criteria), () => this.source.findManyActive(criteria), {
      policy: this.policy,
      codec: LIST_CODEC,
      label: 'catalog.product_list',
    });
  }

  async findActiveByIdOrSlug(idOrSlug: string): Promise<Product | null> {
    const version = await this.cache.readCounter(CATALOG_CACHE_VERSION_KEY);
    if (version === null) {
      this.metrics.recordCatalogCacheOperation('error');
      return this.source.findActiveByIdOrSlug(idOrSlug);
    }

    return this.swr.readThroughSwr(
      productDetailKey(version, idOrSlug),
      () => this.source.findActiveByIdOrSlug(idOrSlug),
      { policy: this.policy, codec: DETAIL_CODEC, label: 'catalog.product_detail' },
    );
  }

  // Uncached passthroughs: Cart prices a line off these reads and Order snapshots the price it
  // charges from the same ones, where a stale price or a stale isActive is a wrong order, not a
  // slow one.
  findSkuView(skuId: string): Promise<SkuView | null> {
    return this.source.findSkuView(skuId);
  }

  findManySkuViews(skuIds: string[]): Promise<SkuView[]> {
    return this.source.findManySkuViews(skuIds);
  }
}
