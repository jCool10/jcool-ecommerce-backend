import { Module } from '@nestjs/common';
import { CatalogModule } from '@modules/catalog/catalog.module';
import { CART_REPOSITORY } from './application/ports/cart-repository.port';
import { CATALOG_QUERY } from './application/ports/catalog-query.port';
import { CartService } from './application/cart.service';
import { CatalogQueryAdapter } from './infrastructure/catalog-query.adapter';
import { DrizzleCartRepository } from './infrastructure/drizzle-cart.repository';
import { CartController } from './interface/cart.controller';

/**
 * Cart bounded context: per-user scratch cart. Reads live SKU price/name only
 * through Catalog's published `CATALOG_SKU_QUERY` (imported via CatalogModule),
 * wrapped by a Cart-owned port so the boundary is explicit. Persistence sits
 * behind CART_REPOSITORY — the single swap point (Redis-backed cart later).
 */
@Module({
  imports: [CatalogModule],
  controllers: [CartController],
  providers: [
    CartService,
    { provide: CART_REPOSITORY, useClass: DrizzleCartRepository },
    { provide: CATALOG_QUERY, useClass: CatalogQueryAdapter },
  ],
})
export class CartModule {}
