import { Module } from '@nestjs/common';
import { CacheModule } from '@shared/cache';
import { CATALOG_ADMIN_REPOSITORY, CATALOG_SEARCH, PRODUCT_REPOSITORY } from './application/ports';
import { CATALOG_SKU_QUERY } from './application/public/catalog-sku-query.port';
import { CatalogAdminService } from './application/services/catalog-admin.service';
import { CatalogSkuQueryService } from './application/services/catalog-sku-query.service';
import { GetProductDetailUseCase, ListProductsUseCase } from './application/use-cases';
import {
  CachingCatalogAdminRepository,
  CachingProductRepository,
  DrizzleCatalogAdminRepository,
  DrizzleProductRepository,
  MeilisearchCatalogSearch,
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
  imports: [CacheModule],
  controllers: [CatalogController, AdminCatalogController],
  providers: [
    ListProductsUseCase,
    GetProductDetailUseCase,
    CatalogAdminService,
    DrizzleProductRepository,
    DrizzleCatalogAdminRepository,
    { provide: PRODUCT_REPOSITORY, useClass: CachingProductRepository },
    { provide: CATALOG_ADMIN_REPOSITORY, useClass: CachingCatalogAdminRepository },
    { provide: CATALOG_SKU_QUERY, useClass: CatalogSkuQueryService },
    { provide: CATALOG_SEARCH, useClass: MeilisearchCatalogSearch },
  ],
  exports: [CATALOG_SKU_QUERY],
})
export class CatalogModule {}
