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
  OnPaymentAuthorizedUseCase,
  PayOrderUseCase,
  SweepIdempotencyKeysUseCase,
  SweepRejectedOrdersUseCase,
} from './application/use-cases';
import { OrderQueryService } from './application/order-query.service';
import { ORDER_REPOSITORY } from './application/ports/order-repository.port';
import { CART_SNAPSHOT_READER } from './application/ports/cart-snapshot.port';
import { CATALOG_QUERY } from './application/ports/catalog-query.port';
import { CHECKOUT_SAGA_ENGINE } from './application/ports/checkout-saga-engine.port';
import { INVENTORY_TCC } from './application/ports/inventory-participant.port';
import { PAYMENT_TCC } from './application/ports/payment-participant.port';
import { IDEMPOTENCY_STORE } from './application/ports/idempotency-store.port';
import { USER_CONTACT, type UserContactPort } from './application/ports/user-contact.port';
import { CheckoutOrderWriter } from './application/saga/checkout-order.writer';
import { CHECKOUT_SAGA_SETTINGS, checkoutSagaSettingsFrom } from './application/saga/checkout-saga.settings';
import { DrizzleOrderRepository } from './infrastructure/drizzle-order.repository';
import { RemoteUserContactAdapter } from './infrastructure/user-contact.adapters';
import { CartSnapshotAdapter } from './infrastructure/cart-snapshot.adapter';
import { CatalogQueryAdapter } from './infrastructure/catalog-query.adapter';
import { InventoryParticipantAdapter } from './infrastructure/inventory-participant.adapter';
import { PaymentParticipantAdapter } from './infrastructure/payment-participant.adapter';
import { DrizzleIdempotencyKeyRepository } from './infrastructure/drizzle-idempotency-key.repository';
import { TemporalCheckoutSagaEngine } from './infrastructure/temporal/temporal-checkout-saga.engine';
import { temporalProviders } from './infrastructure/temporal/temporal.providers';
import { AdminOrderController } from './interface/admin-order.controller';
import { CheckoutReservingReaperScheduler } from './interface/checkout-reserving-reaper.scheduler';
import { OrderController } from './interface/order.controller';
import { IdempotencyInterceptor } from './interface/idempotency.interceptor';
import { OrderPaidMailHandler } from './interface/queue/order-paid-mail.handler';
import { PaymentAuthorizedHandler } from './interface/queue/payment-authorized.handler';
import { RequireIdempotencyKeyGuard } from './interface/require-idempotency-key.guard';
import { CheckoutSagaWorker, checkoutSagaActivitiesProvider } from './interface/temporal/checkout-saga.worker';
import { TemporalReadinessCheck } from './interface/temporal/temporal-readiness.check';

/**
 * Order orchestrates the checkout saga, whose state lives in a Temporal workflow run by a worker in
 * this process. Every cross-context call — Cart's CART_SNAPSHOT, Product's PRODUCT_SKU_QUERY and
 * INVENTORY_PARTICIPANT, Payment's PAYMENT_PARTICIPANT — goes through an Order-owned adapter bound
 * to an Order port, so nothing here imports another context's domain or infrastructure.
 */
@Module({
  imports: [CartModule, ProductModule, PaymentModule, MailModule, ResilienceModule],
  controllers: [OrderController, AdminOrderController],
  providers: [
    CheckoutOrderUseCase,
    PayOrderUseCase,
    CancelOrderUseCase,
    OnPaymentAuthorizedUseCase,
    // Both register themselves with the shared retention registry on init; nothing here drives them.
    SweepIdempotencyKeysUseCase,
    SweepRejectedOrdersUseCase,
    OrderQueryService,
    CheckoutOrderWriter,
    CheckoutReservingReaperScheduler,
    ...temporalProviders,
    checkoutSagaActivitiesProvider,
    CheckoutSagaWorker,
    TemporalReadinessCheck,
    { provide: CHECKOUT_SAGA_ENGINE, useClass: TemporalCheckoutSagaEngine },
    { provide: CHECKOUT_SAGA_SETTINGS, inject: [ConfigService], useFactory: checkoutSagaSettingsFrom },
    { provide: ORDER_REPOSITORY, useClass: DrizzleOrderRepository },
    { provide: CART_SNAPSHOT_READER, useClass: CartSnapshotAdapter },
    { provide: CATALOG_QUERY, useClass: CatalogQueryAdapter },
    { provide: INVENTORY_TCC, useClass: InventoryParticipantAdapter },
    { provide: PAYMENT_TCC, useClass: PaymentParticipantAdapter },
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
  ],
  // The queue handlers are exported so the shared event consumer can route an authorization and a
  // confirmation back here.
  exports: [PaymentAuthorizedHandler, OrderPaidMailHandler],
})
export class OrderModule {}
