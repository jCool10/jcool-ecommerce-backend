import { Module } from '@nestjs/common';
import { CacheModule } from '@shared/cache';
import { MediaModule } from '@modules/media/media.module';
import { CATALOG_ADMIN_REPOSITORY, CATALOG_SEARCH, MEDIA_QUERY, PRODUCT_REPOSITORY } from './application/ports';
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
 * Catalog bounded context — public read paths + admin write paths (`@Roles(Role.Admin)`),
 * read and write behind separate ports (CQRS-lite) so each port→adapter binding is a single
 * swap point. `CATALOG_SKU_QUERY` is the published SKU-read language exported for other
 * contexts (Cart reads live price/name through it, never Catalog's internals).
 *
 * Both ports resolve to a cache-aside decorator that wraps the Drizzle adapter (registered under
 * its own class token, injected by type): reads serve from Redis, writes bump the generation that
 * invalidates them. Everything above the port — controllers, use cases, domain — is unaware.
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
    { provide: CATALOG_ADMIN_REPOSITORY, useClass: CachingCatalogAdminRepository },
    { provide: CATALOG_SKU_QUERY, useClass: CatalogSkuQueryService },
    { provide: CATALOG_SEARCH, useClass: MeilisearchCatalogSearch },
    { provide: MEDIA_QUERY, useClass: MediaQueryAdapter },
    SearchIndexBootstrap,
  ],
  exports: [CATALOG_SKU_QUERY],
})
export class CatalogModule {}
