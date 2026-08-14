import { Module } from '@nestjs/common';
import { CatalogModule } from '@modules/catalog/catalog.module';
import { CART_REPOSITORY } from './application/ports/cart-repository.port';
import { CATALOG_QUERY } from './application/ports/catalog-query.port';
import { CART_SNAPSHOT } from './application/public/cart-snapshot.port';
import { CartSnapshotService } from './application/public/cart-snapshot.service';
import { CartService } from './application/cart.service';
import { CatalogQueryAdapter } from './infrastructure/catalog-query.adapter';
import { DrizzleCartRepository } from './infrastructure/drizzle-cart.repository';
import { CartController } from './interface/cart.controller';

/**
 * Cart bounded context: per-user scratch cart. Reads live SKU price/name only
 * through Catalog's published `CATALOG_SKU_QUERY` (imported via CatalogModule),
 * wrapped by a Cart-owned port so the boundary is explicit. Persistence sits
 * behind CART_REPOSITORY — the single swap point (Redis-backed cart later).
 * `CART_SNAPSHOT` is Cart's published language, exported so Order can snapshot
 * the cart into an order.
 */
@Module({
  imports: [CatalogModule],
  controllers: [CartController],
  providers: [
    CartService,
    { provide: CART_REPOSITORY, useClass: DrizzleCartRepository },
    { provide: CATALOG_QUERY, useClass: CatalogQueryAdapter },
    { provide: CART_SNAPSHOT, useClass: CartSnapshotService },
  ],
  exports: [CART_SNAPSHOT],
})
export class CartModule {}
