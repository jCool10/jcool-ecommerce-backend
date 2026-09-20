import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CartModule } from '@modules/cart/cart.module';
import { CatalogModule } from '@modules/catalog/catalog.module';
import { InventoryModule } from '@modules/inventory/inventory.module';
import { USER_FACADE, type UserFacade } from '@modules/user/application/public/user-facade.port';
import { UserModule } from '@modules/user/user.module';
import { createUserServiceClient } from '@shared/user-service/user-service.client';
import { durationToMs } from '@jcool/kernel';
import { MailModule } from '@jcool/platform/mail';
import { CircuitBreakerFactory, ResilienceModule } from '@jcool/platform/resilience';
import {
  CancelOrderUseCase,
  CheckoutOrderUseCase,
  FinalizeOrderUseCase,
  SweepExpiredReservationsUseCase,
  SweepIdempotencyKeysUseCase,
} from './application/use-cases';
import { OrderQueryService } from './application/order-query.service';
import { ORDER_PAYMENT_VIEW } from './application/public/order-payment-view.port';
import { OrderPaymentViewService } from './application/public/order-payment-view.service';
import { ORDER_REPOSITORY } from './application/ports/order-repository.port';
import { CART_SNAPSHOT_READER } from './application/ports/cart-snapshot.port';
import { CATALOG_QUERY } from './application/ports/catalog-query.port';
import { INVENTORY_RESERVATION } from './application/ports/inventory-reservation.port';
import { IDEMPOTENCY_STORE } from './application/ports/idempotency-store.port';
import { USER_CONTACT, type UserContactPort } from './application/ports/user-contact.port';
import { DrizzleOrderRepository } from './infrastructure/drizzle-order.repository';
import { LocalUserContactAdapter, RemoteUserContactAdapter } from './infrastructure/user-contact.adapters';
import { CartSnapshotAdapter } from './infrastructure/cart-snapshot.adapter';
import { CatalogQueryAdapter } from './infrastructure/catalog-query.adapter';
import { InventoryReservationAdapter } from './infrastructure/inventory-reservation.adapter';
import { DrizzleIdempotencyKeyRepository } from './infrastructure/drizzle-idempotency-key.repository';
import { AdminOrderController } from './interface/admin-order.controller';
import { OrderController } from './interface/order.controller';
import { IdempotencyInterceptor } from './interface/idempotency.interceptor';
import { OrderPaidMailHandler } from './interface/queue/order-paid-mail.handler';
import { PaymentEventsHandler } from './interface/queue/payment-events.handler';
import { RequireIdempotencyKeyGuard } from './interface/require-idempotency-key.guard';
import { ReservationTtlScheduler } from './interface/reservation-ttl.scheduler';

/**
 * Every cross-context read or write — Cart's CART_SNAPSHOT, Catalog's CATALOG_SKU_QUERY, Inventory's
 * STOCK_RESERVATION — goes through an Order-owned anti-corruption adapter bound to an Order port, so
 * nothing in this module imports another context's domain or infrastructure.
 */
@Module({
  // UserModule only backs the `local` user directory.
  imports: [CartModule, CatalogModule, InventoryModule, UserModule, MailModule, ResilienceModule],
  controllers: [OrderController, AdminOrderController],
  providers: [
    CheckoutOrderUseCase,
    CancelOrderUseCase,
    FinalizeOrderUseCase,
    SweepExpiredReservationsUseCase,
    // Registers itself with the shared retention registry on init; nothing here drives it.
    SweepIdempotencyKeysUseCase,
    OrderQueryService,
    { provide: ORDER_REPOSITORY, useClass: DrizzleOrderRepository },
    { provide: CART_SNAPSHOT_READER, useClass: CartSnapshotAdapter },
    { provide: CATALOG_QUERY, useClass: CatalogQueryAdapter },
    { provide: INVENTORY_RESERVATION, useClass: InventoryReservationAdapter },
    { provide: IDEMPOTENCY_STORE, useClass: DrizzleIdempotencyKeyRepository },
    { provide: ORDER_PAYMENT_VIEW, useClass: OrderPaymentViewService },
    {
      provide: USER_CONTACT,
      inject: [ConfigService, USER_FACADE, CircuitBreakerFactory],
      useFactory: (config: ConfigService, users: UserFacade, breakers: CircuitBreakerFactory): UserContactPort =>
        config.getOrThrow<string>('userDirectory.source') === 'remote'
          ? new RemoteUserContactAdapter(
              createUserServiceClient(config, breakers),
              durationToMs(config.getOrThrow<string>('userDirectory.notFoundGrace')),
            )
          : new LocalUserContactAdapter(users),
    },
    RequireIdempotencyKeyGuard,
    IdempotencyInterceptor,
    PaymentEventsHandler,
    OrderPaidMailHandler,
    ReservationTtlScheduler,
  ],
  // FinalizeOrderUseCase is exported so Payment's webhook and sweep can settle an order, and the two
  // queue handlers so the shared event consumer can route a settlement and a confirmation back here.
  exports: [ORDER_PAYMENT_VIEW, FinalizeOrderUseCase, PaymentEventsHandler, OrderPaidMailHandler],
})
export class OrderModule {}
