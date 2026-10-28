import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CircuitBreakerFactory, ResilienceModule } from '@jcool/platform/resilience';
import { CacheModule } from '@shared/cache';
import { MediaModule } from '@modules/media/media.module';
import {
  CATALOG_ADMIN_REPOSITORY,
  CATALOG_SEARCH,
  MEDIA_QUERY,
  PRODUCT_REPOSITORY,
  PRODUCT_SEARCH_STATE,
} from './application/catalog/ports';
import { CatalogAdminService } from './application/catalog/services/catalog-admin.service';
import { CatalogSkuQueryService } from './application/catalog/services/catalog-sku-query.service';
import { ProductSearchSyncService } from './application/catalog/services/product-search-sync.service';
import { GetProductDetailUseCase, ListProductsUseCase, SearchProductsUseCase } from './application/catalog/use-cases';
import { PRODUCT_SKU_QUERY } from './application/public/product-sku-query.port';
import {
  CachingCatalogAdminRepository,
  CachingProductRepository,
  DrizzleCatalogAdminRepository,
  DrizzleProductRepository,
  ElasticsearchCatalogSearch,
  MediaQueryAdapter,
  SEARCH_ENGINE_CALLS,
  SEARCH_READ_BREAKER,
  SEARCH_WRITE_BREAKER,
  SearchIndexBootstrap,
  isSearchEngineFault,
  type SearchEngineCalls,
} from './infrastructure/catalog';
import { AdminCatalogController } from './interface/catalog/admin-catalog.controller';
import { CatalogController } from './interface/catalog/catalog.controller';
import { CategoryRenamedHandler } from './interface/catalog/queue/category-renamed.handler';
import { ProductChangedHandler } from './interface/catalog/queue/product-changed.handler';

/** Catalog's read and write ports resolve to cache-aside decorators over the Drizzle adapters. */
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
    { provide: PRODUCT_SKU_QUERY, useClass: CatalogSkuQueryService },
    {
      provide: SEARCH_ENGINE_CALLS,
      inject: [ConfigService, CircuitBreakerFactory],
      useFactory: (config: ConfigService, breakers: CircuitBreakerFactory): SearchEngineCalls => {
        const options = {
          timeoutMs: config.getOrThrow<number>('search.requestTimeoutMs'),
          isDownstreamFault: isSearchEngineFault,
        };
        return {
          read: breakers.create(SEARCH_READ_BREAKER, options),
          write: breakers.create(SEARCH_WRITE_BREAKER, options),
        };
      },
    },
    { provide: CATALOG_SEARCH, useClass: ElasticsearchCatalogSearch },
    { provide: MEDIA_QUERY, useClass: MediaQueryAdapter },
    SearchIndexBootstrap,
    ProductSearchSyncService,
    ProductChangedHandler,
    CategoryRenamedHandler,
  ],
  exports: [PRODUCT_SKU_QUERY, ProductChangedHandler, CategoryRenamedHandler],
})
export class ProductModule {}
