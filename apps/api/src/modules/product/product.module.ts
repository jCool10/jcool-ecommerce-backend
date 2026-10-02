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
import { PRODUCT_STOCK_RESERVATION } from './application/public/product-stock-reservation.port';
import { StockAdminService } from './application/stock/stock-admin.service';
import { STOCK_ADMIN } from './application/stock/ports/stock-admin.port';
import { STOCK_REPOSITORY } from './application/stock/ports/stock-repository.port';
import { ReserveStockUseCase } from './application/stock/reserve-stock.use-case';
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
import { StockAdminRepository } from './infrastructure/stock/stock-admin.repository';
import { StockRepository } from './infrastructure/stock/stock.repository';
import { AdminCatalogController } from './interface/catalog/admin-catalog.controller';
import { CatalogController } from './interface/catalog/catalog.controller';
import { CategoryRenamedHandler } from './interface/catalog/queue/category-renamed.handler';
import { ProductChangedHandler } from './interface/catalog/queue/product-changed.handler';
import { AdminInventoryController } from './interface/stock/admin-inventory.controller';

/**
 * One module, two aggregate groups: catalog and stock reference each other only by `variantId`, and
 * no use case writes both in one transaction. Catalog's read and write ports resolve to cache-aside
 * decorators over the Drizzle adapters; a stock write must never bump the catalog cache generation.
 * STOCK_ADMIN stays unexported: setting stock outright is not something another context may do on a
 * buyer's behalf.
 */
@Module({
  // MediaModule for `MEDIA_FACADE` only — image bytes and their lifecycle stay entirely over there.
  imports: [CacheModule, MediaModule, ResilienceModule],
  controllers: [CatalogController, AdminCatalogController, AdminInventoryController],
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
    ReserveStockUseCase,
    StockAdminService,
    { provide: STOCK_REPOSITORY, useClass: StockRepository },
    { provide: STOCK_ADMIN, useClass: StockAdminRepository },
    { provide: PRODUCT_STOCK_RESERVATION, useExisting: ReserveStockUseCase },
  ],
  exports: [
    PRODUCT_SKU_QUERY,
    PRODUCT_STOCK_RESERVATION,
    STOCK_REPOSITORY,
    ProductChangedHandler,
    CategoryRenamedHandler,
  ],
})
export class ProductModule {}
