import { Module } from '@nestjs/common';
import { CATALOG_ADMIN_REPOSITORY, PRODUCT_REPOSITORY } from './application/ports';
import { CATALOG_SKU_QUERY } from './application/public/catalog-sku-query.port';
import { CatalogAdminService } from './application/services/catalog-admin.service';
import { CatalogSkuQueryService } from './application/services/catalog-sku-query.service';
import { GetProductDetailUseCase, ListProductsUseCase } from './application/use-cases';
import { DrizzleCatalogAdminRepository, DrizzleProductRepository } from './infrastructure';
import { AdminCatalogController } from './interface/admin-catalog.controller';
import { CatalogController } from './interface/catalog.controller';

/**
 * Catalog bounded context — public read paths + admin write paths (`@Roles(Role.Admin)`),
 * read and write behind separate ports (CQRS-lite) so each port→adapter binding is a single
 * swap point. `CATALOG_SKU_QUERY` is the published SKU-read language exported for other
 * contexts (Cart reads live price/name through it, never Catalog's internals).
 */
@Module({
  controllers: [CatalogController, AdminCatalogController],
  providers: [
    ListProductsUseCase,
    GetProductDetailUseCase,
    CatalogAdminService,
    { provide: PRODUCT_REPOSITORY, useClass: DrizzleProductRepository },
    { provide: CATALOG_ADMIN_REPOSITORY, useClass: DrizzleCatalogAdminRepository },
    { provide: CATALOG_SKU_QUERY, useClass: CatalogSkuQueryService },
  ],
  exports: [CATALOG_SKU_QUERY],
})
export class CatalogModule {}
