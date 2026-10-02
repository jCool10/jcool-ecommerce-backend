import { Module } from '@nestjs/common';
import { ProductModule } from '@modules/product/product.module';
import { CART_REPOSITORY } from './application/ports/cart-repository.port';
import { CATALOG_QUERY } from './application/ports/catalog-query.port';
import { CART_SNAPSHOT } from './application/public/cart-snapshot.port';
import { CartSnapshotService } from './application/public/cart-snapshot.service';
import { CartService } from './application/cart.service';
import { CatalogQueryAdapter } from './infrastructure/catalog-query.adapter';
import { DrizzleCartRepository } from './infrastructure/drizzle-cart.repository';
import { CartController } from './interface/cart.controller';

@Module({
  imports: [ProductModule],
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
