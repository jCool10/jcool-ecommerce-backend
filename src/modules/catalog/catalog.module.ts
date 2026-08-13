import { Module } from '@nestjs/common';
import { CATALOG_ADMIN_REPOSITORY, PRODUCT_REPOSITORY } from './application/ports';
import { CatalogAdminService } from './application/services/catalog-admin.service';
import { GetProductDetailUseCase, ListProductsUseCase } from './application/use-cases';
import { DrizzleCatalogAdminRepository, DrizzleProductRepository } from './infrastructure';
import { AdminCatalogController } from './interface/admin-catalog.controller';
import { CatalogController } from './interface/catalog.controller';

/** Catalog bounded context — public read paths + admin write paths (`@Roles(Role.Admin)`), read and write behind separate ports (CQRS-lite) so each port→adapter binding is a single swap point. */
@Module({
  controllers: [CatalogController, AdminCatalogController],
  providers: [
    ListProductsUseCase,
    GetProductDetailUseCase,
    CatalogAdminService,
    { provide: PRODUCT_REPOSITORY, useClass: DrizzleProductRepository },
    { provide: CATALOG_ADMIN_REPOSITORY, useClass: DrizzleCatalogAdminRepository },
  ],
})
export class CatalogModule {}
