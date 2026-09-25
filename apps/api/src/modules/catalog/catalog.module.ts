import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CircuitBreakerFactory, ResilienceModule, type OutboundCall } from '@jcool/platform/resilience';
import { CacheModule } from '@shared/cache';
import { MediaModule } from '@modules/media/media.module';
import {
  CATALOG_ADMIN_REPOSITORY,
  CATALOG_SEARCH,
  MEDIA_QUERY,
  PRODUCT_REPOSITORY,
  PRODUCT_SEARCH_STATE,
} from './application/ports';
import { CATALOG_SKU_QUERY } from './application/public/catalog-sku-query.port';
import { CatalogAdminService } from './application/services/catalog-admin.service';
import { CatalogSkuQueryService } from './application/services/catalog-sku-query.service';
import { GetProductDetailUseCase, ListProductsUseCase, SearchProductsUseCase } from './application/use-cases';
import {
  CachingCatalogAdminRepository,
  CachingProductRepository,
  DrizzleCatalogAdminRepository,
  DrizzleProductRepository,
  ElasticsearchCatalogSearch,
  MediaQueryAdapter,
  SEARCH_ENGINE_BREAKER,
  SEARCH_ENGINE_CALL,
  SearchIndexBootstrap,
  isSearchEngineFault,
} from './infrastructure';
import { AdminCatalogController } from './interface/admin-catalog.controller';
import { CatalogController } from './interface/catalog.controller';

/**
 * `CATALOG_SKU_QUERY` is the published SKU-read language for other contexts (Cart reads live
 * price/name through it, never Catalog's internals). The read and write ports resolve to
 * cache-aside decorators wrapping the Drizzle adapters, which are registered under their own
 * class tokens and injected by type; everything above the port is unaware of the cache.
 */
@Module({
  // MediaModule for `MEDIA_FACADE` only — image bytes and their lifecycle stay entirely over there.
  imports: [CacheModule, MediaModule, ResilienceModule],
  controllers: [CatalogController, AdminCatalogController],
  providers: [
    ListProductsUseCase,
    GetProductDetailUseCase,
    SearchProductsUseCase,
    CatalogAdminService,
    DrizzleProductRepository,
    DrizzleCatalogAdminRepository,
    { provide: PRODUCT_REPOSITORY, useClass: CachingProductRepository },
    { provide: PRODUCT_SEARCH_STATE, useExisting: DrizzleProductRepository },
    { provide: CATALOG_ADMIN_REPOSITORY, useClass: CachingCatalogAdminRepository },
    { provide: CATALOG_SKU_QUERY, useClass: CatalogSkuQueryService },
    {
      provide: SEARCH_ENGINE_CALL,
      inject: [ConfigService, CircuitBreakerFactory],
      useFactory: (config: ConfigService, breakers: CircuitBreakerFactory): OutboundCall =>
        breakers.create(SEARCH_ENGINE_BREAKER, {
          timeoutMs: config.getOrThrow<number>('search.requestTimeoutMs'),
          isDownstreamFault: isSearchEngineFault,
        }),
    },
    { provide: CATALOG_SEARCH, useClass: ElasticsearchCatalogSearch },
    { provide: MEDIA_QUERY, useClass: MediaQueryAdapter },
    SearchIndexBootstrap,
  ],
  exports: [CATALOG_SKU_QUERY],
})
export class CatalogModule {}
