import { Module } from '@nestjs/common';
import { CartModule } from '@modules/cart/cart.module';
import { CatalogModule } from '@modules/catalog/catalog.module';
import { OrderService } from './application/order.service';
import { ORDER_REPOSITORY } from './application/ports/order-repository.port';
import { CART_SNAPSHOT_READER } from './application/ports/cart-snapshot.port';
import { CATALOG_QUERY } from './application/ports/catalog-query.port';
import { INVENTORY_RESERVATION } from './application/ports/inventory-reservation.port';
import { DrizzleOrderRepository } from './infrastructure/drizzle-order.repository';
import { CartSnapshotAdapter } from './infrastructure/cart-snapshot.adapter';
import { CatalogQueryAdapter } from './infrastructure/catalog-query.adapter';
import { NoopInventoryReservation } from './infrastructure/noop-inventory-reservation.adapter';
import { OrderController } from './interface/order.controller';

/**
 * Order bounded context: the transactional source of truth. Creating an order
 * snapshots the cart — raw lines via Cart's published CART_SNAPSHOT (through
 * CartModule), price/name resolved live via Catalog's CATALOG_SKU_QUERY (through
 * CatalogModule), then frozen. Both cross-context reads go through Order-owned
 * anti-corruption adapters. Persistence sits behind ORDER_REPOSITORY.
 */
@Module({
  imports: [CartModule, CatalogModule],
  controllers: [OrderController],
  providers: [
    OrderService,
    { provide: ORDER_REPOSITORY, useClass: DrizzleOrderRepository },
    { provide: CART_SNAPSHOT_READER, useClass: CartSnapshotAdapter },
    { provide: CATALOG_QUERY, useClass: CatalogQueryAdapter },
    { provide: INVENTORY_RESERVATION, useClass: NoopInventoryReservation },
  ],
})
export class OrderModule {}
