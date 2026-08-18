import { Module } from '@nestjs/common';
import { CartModule } from '@modules/cart/cart.module';
import { CatalogModule } from '@modules/catalog/catalog.module';
import { InventoryModule } from '@modules/inventory/inventory.module';
import { CreateOrderFromCartUseCase, PlaceOrderUseCase } from './application/use-cases';
import { OrderQueryService } from './application/order-query.service';
import { ORDER_REPOSITORY } from './application/ports/order-repository.port';
import { CART_SNAPSHOT_READER } from './application/ports/cart-snapshot.port';
import { CATALOG_QUERY } from './application/ports/catalog-query.port';
import { INVENTORY_RESERVATION } from './application/ports/inventory-reservation.port';
import { IDEMPOTENCY_STORE } from './application/ports/idempotency-store.port';
import { DrizzleOrderRepository } from './infrastructure/drizzle-order.repository';
import { CartSnapshotAdapter } from './infrastructure/cart-snapshot.adapter';
import { CatalogQueryAdapter } from './infrastructure/catalog-query.adapter';
import { InventoryReservationAdapter } from './infrastructure/inventory-reservation.adapter';
import { DrizzleIdempotencyKeyRepository } from './infrastructure/drizzle-idempotency-key.repository';
import { OrderController } from './interface/order.controller';
import { IdempotencyInterceptor } from './interface/idempotency.interceptor';
import { RequireIdempotencyKeyGuard } from './interface/require-idempotency-key.guard';

/**
 * Order bounded context: the transactional source of truth. Creating an order
 * snapshots the cart — raw lines via Cart's published CART_SNAPSHOT (through
 * CartModule), price/name resolved live via Catalog's CATALOG_SKU_QUERY (through
 * CatalogModule), then frozen. Both cross-context reads go through Order-owned
 * anti-corruption adapters. Placing an order holds stock via Inventory's published
 * STOCK_RESERVATION (through InventoryModule), again behind an Order-owned adapter.
 * Persistence sits behind ORDER_REPOSITORY.
 */
@Module({
  imports: [CartModule, CatalogModule, InventoryModule],
  controllers: [OrderController],
  providers: [
    CreateOrderFromCartUseCase,
    PlaceOrderUseCase,
    OrderQueryService,
    { provide: ORDER_REPOSITORY, useClass: DrizzleOrderRepository },
    { provide: CART_SNAPSHOT_READER, useClass: CartSnapshotAdapter },
    { provide: CATALOG_QUERY, useClass: CatalogQueryAdapter },
    { provide: INVENTORY_RESERVATION, useClass: InventoryReservationAdapter },
    { provide: IDEMPOTENCY_STORE, useClass: DrizzleIdempotencyKeyRepository },
    RequireIdempotencyKeyGuard,
    IdempotencyInterceptor,
  ],
})
export class OrderModule {}
