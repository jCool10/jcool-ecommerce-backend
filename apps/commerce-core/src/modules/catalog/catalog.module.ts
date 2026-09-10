import { Module } from '@nestjs/common';
import { CacheModule } from '@shared/cache';
import { MediaModule } from '@modules/media/media.module';
import {
  CATALOG_ADMIN_REPOSITORY,
  CATALOG_SEARCH,
  MEDIA_QUERY,
  PRODUCT_REPOSITORY,
  PRODUCT_SOURCE_REPOSITORY,
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
  MediaQueryAdapter,
  MeilisearchCatalogSearch,
  SearchIndexBootstrap,
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
  imports: [CacheModule, MediaModule],
  controllers: [CatalogController, AdminCatalogController],
  providers: [
    ListProductsUseCase,
    GetProductDetailUseCase,
    SearchProductsUseCase,
    CatalogAdminService,
    DrizzleProductRepository,
    DrizzleCatalogAdminRepository,
    { provide: PRODUCT_REPOSITORY, useClass: CachingProductRepository },
    { provide: PRODUCT_SOURCE_REPOSITORY, useExisting: DrizzleProductRepository },
    { provide: CATALOG_ADMIN_REPOSITORY, useClass: CachingCatalogAdminRepository },
    { provide: CATALOG_SKU_QUERY, useClass: CatalogSkuQueryService },
    { provide: CATALOG_SEARCH, useClass: MeilisearchCatalogSearch },
    { provide: MEDIA_QUERY, useClass: MediaQueryAdapter },
    SearchIndexBootstrap,
  ],
  exports: [CATALOG_SKU_QUERY],
})
export class CatalogModule {}
