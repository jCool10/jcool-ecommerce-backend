import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClsService } from 'nestjs-cls';
import { CartModule } from '@modules/cart/cart.module';
import { PaymentModule } from '@modules/payment/payment.module';
import { ProductModule } from '@modules/product/product.module';
import { createUserServiceClient } from '@shared/user-service/user-service.client';
import { durationToMs } from '@jcool/kernel';
import { MailModule } from '@jcool/platform/mail';
import { CircuitBreakerFactory, ResilienceModule } from '@jcool/platform/resilience';
import {
  CancelOrderUseCase,
  CheckoutOrderUseCase,
  ForwardPaymentAuthorizationUseCase,
  PayOrderUseCase,
  ReapReservingOrdersUseCase,
  SweepIdempotencyKeysUseCase,
  SweepRejectedOrdersUseCase,
} from './application/use-cases';
import { OrderQueryService } from './application/order-query.service';
import { ORDER_REPOSITORY } from './application/ports/order-repository.port';
import { CHECKOUT_SAGA_ENGINE } from './application/ports/checkout-saga-engine.port';
import { CART_SNAPSHOT_READER } from './application/ports/cart-snapshot.port';
import { CATALOG_QUERY } from './application/ports/catalog-query.port';
import { IDEMPOTENCY_STORE } from './application/ports/idempotency-store.port';
import { ORDER_INVENTORY_PARTICIPANT } from './application/ports/order-inventory-participant.port';
import { ORDER_PAYMENT_PARTICIPANT } from './application/ports/order-payment-participant.port';
import { USER_CONTACT, type UserContactPort } from './application/ports/user-contact.port';
import { DrizzleOrderRepository } from './infrastructure/drizzle-order.repository';
import { RemoteUserContactAdapter } from './infrastructure/user-contact.adapters';
import { CartSnapshotAdapter } from './infrastructure/cart-snapshot.adapter';
import { CatalogQueryAdapter } from './infrastructure/catalog-query.adapter';
import { OrderInventoryParticipantAdapter } from './infrastructure/order-inventory-participant.adapter';
import { OrderPaymentParticipantAdapter } from './infrastructure/order-payment-participant.adapter';
import { DrizzleIdempotencyKeyRepository } from './infrastructure/drizzle-idempotency-key.repository';
import { CheckoutSagaActivities } from './infrastructure/temporal/checkout-saga.activities';
import { CheckoutSagaWorker } from './infrastructure/temporal/checkout-saga.worker';
import { TemporalCheckoutSagaEngine } from './infrastructure/temporal/temporal-checkout-saga.engine';
import { temporalProviders } from './infrastructure/temporal/temporal.providers';
import { AdminOrderController } from './interface/admin-order.controller';
import { CheckoutReservingReaperScheduler } from './interface/checkout-reserving-reaper.scheduler';
import { OrderController } from './interface/order.controller';
import { IdempotencyInterceptor } from './interface/idempotency.interceptor';
import { OrderPaidMailHandler } from './interface/queue/order-paid-mail.handler';
import { PaymentAuthorizedHandler } from './interface/queue/payment-authorized.handler';
import { RequireIdempotencyKeyGuard } from './interface/require-idempotency-key.guard';

/**
 * Every cross-context read or write — Cart's CART_SNAPSHOT, Product's PRODUCT_SKU_QUERY and
 * INVENTORY_PARTICIPANT, Payment's PAYMENT_PARTICIPANT — goes through
 * an Order-owned anti-corruption adapter bound to an Order port, so nothing in this module imports
 * another context's domain or infrastructure.
 */
@Module({
  imports: [CartModule, ProductModule, PaymentModule, MailModule, ResilienceModule],
  controllers: [OrderController, AdminOrderController],
  providers: [
    CheckoutOrderUseCase,
    PayOrderUseCase,
    CancelOrderUseCase,
    ForwardPaymentAuthorizationUseCase,
    ReapReservingOrdersUseCase,
    // These register themselves with the shared retention registry on init; nothing here drives them.
    SweepIdempotencyKeysUseCase,
    SweepRejectedOrdersUseCase,
    OrderQueryService,
    { provide: ORDER_REPOSITORY, useClass: DrizzleOrderRepository },
    { provide: CART_SNAPSHOT_READER, useClass: CartSnapshotAdapter },
    { provide: CATALOG_QUERY, useClass: CatalogQueryAdapter },
    { provide: ORDER_INVENTORY_PARTICIPANT, useClass: OrderInventoryParticipantAdapter },
    { provide: ORDER_PAYMENT_PARTICIPANT, useClass: OrderPaymentParticipantAdapter },
    { provide: IDEMPOTENCY_STORE, useClass: DrizzleIdempotencyKeyRepository },
    {
      provide: USER_CONTACT,
      inject: [ConfigService, CircuitBreakerFactory, ClsService],
      useFactory: (config: ConfigService, breakers: CircuitBreakerFactory, cls: ClsService): UserContactPort =>
        new RemoteUserContactAdapter(
          createUserServiceClient(config, breakers, cls),
          durationToMs(config.getOrThrow<string>('userDirectory.notFoundGrace')),
        ),
    },
    RequireIdempotencyKeyGuard,
    IdempotencyInterceptor,
    PaymentAuthorizedHandler,
    OrderPaidMailHandler,
    CheckoutReservingReaperScheduler,
    ...temporalProviders,
    { provide: CHECKOUT_SAGA_ENGINE, useClass: TemporalCheckoutSagaEngine },
    CheckoutSagaActivities,
    CheckoutSagaWorker,
  ],
  // For the shared event consumer, which routes an authorization and a confirmation back here.
  exports: [PaymentAuthorizedHandler, OrderPaidMailHandler],
})
export class OrderModule {}
