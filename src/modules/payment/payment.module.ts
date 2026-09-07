import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OrderModule } from '@modules/order/order.module';
import { CircuitBreakerFactory, ResilienceModule } from '@shared/resilience';
import { PAYMENT_REPOSITORY } from './application/ports/payment-repository.port';
import { WEBHOOK_EVENT_REPOSITORY } from './application/ports/webhook-event-repository.port';
import { PAYMENT_GATEWAY, type PaymentGatewayPort } from './application/ports/payment-gateway.port';
import { ORDER_READ_PORT } from './application/ports/order-read.port';
import { TRANSACTION_RUNNER } from './application/ports/transaction-runner.port';
import {
  CreatePaymentSessionUseCase,
  ExpirePaymentSessionUseCase,
  HandlePaymentWebhookUseCase,
  ProcessWebhookEventUseCase,
  ReconcileStaleOrdersUseCase,
} from './application/use-cases';
import { DrizzlePaymentRepository } from './infrastructure/payment.repository';
import { DrizzleWebhookEventRepository } from './infrastructure/webhook-event.repository';
import { DrizzleTransactionRunner } from './infrastructure/drizzle-transaction-runner';
import { OrderReadAdapter } from './infrastructure/order-read.adapter';
import { StripeGatewayAdapter } from './infrastructure/gateway/stripe-gateway.adapter';
import { isStripeUnavailable } from './infrastructure/gateway/stripe-fault-classification';
import {
  BreakerPaymentGateway,
  PAYMENT_GATEWAY_BREAKER,
} from './infrastructure/gateway/breaker-payment-gateway.adapter';
import { PaymentController } from './interface/payment.controller';
import { WebhookController } from './interface/webhook.controller';
import { ReconciliationScheduler } from './interface/reconciliation.scheduler';
import { OrderExpiredHandler } from './interface/queue/order-expired.handler';

// Changing gateways is a DI + env change, never a caller change: every caller depends on
// PAYMENT_GATEWAY, so the concrete adapter is chosen here and nowhere else.
// The gateway is fronted by a circuit breaker because it is the one dependency here that lives on
// someone else's network, so it is the one whose slowness can exhaust our request slots.
function createPaymentGateway(config: ConfigService, breakers: CircuitBreakerFactory): PaymentGatewayPort {
  const gateway = new StripeGatewayAdapter({
    webhookSecret: config.get<string>('payment.webhookSecret'),
    toleranceSec: config.get<number>('payment.webhookToleranceSec') ?? 300,
    secretKey: config.get<string>('payment.secretKey'),
    successUrl: config.get<string>('payment.successUrl'),
    cancelUrl: config.get<string>('payment.cancelUrl'),
  });
  // A rejected request (card declined, bad amount) is our fault, not the provider's — counting it
  // as a failure would trip the breaker on perfectly healthy traffic. Only Stripe's own
  // unavailability signals open the circuit.
  const breaker = breakers.create(PAYMENT_GATEWAY_BREAKER, { isDownstreamFault: isStripeUnavailable });
  return new BreakerPaymentGateway(gateway, breaker);
}

/**
 * Payment bounded context: the "never double-charge" invariant. Reads an order only through Order's
 * published ORDER_PAYMENT_VIEW, behind Payment's own ORDER_READ_PORT anti-corruption adapter, and
 * settles one only through Order's exported FinalizeOrderUseCase — never Order's tables.
 */
@Module({
  imports: [OrderModule, ResilienceModule],
  controllers: [PaymentController, WebhookController],
  providers: [
    { provide: PAYMENT_REPOSITORY, useClass: DrizzlePaymentRepository },
    { provide: WEBHOOK_EVENT_REPOSITORY, useClass: DrizzleWebhookEventRepository },
    { provide: PAYMENT_GATEWAY, useFactory: createPaymentGateway, inject: [ConfigService, CircuitBreakerFactory] },
    { provide: ORDER_READ_PORT, useClass: OrderReadAdapter },
    { provide: TRANSACTION_RUNNER, useClass: DrizzleTransactionRunner },
    CreatePaymentSessionUseCase,
    ProcessWebhookEventUseCase,
    // The controller depends on this orchestrator, not the raw processor.
    HandlePaymentWebhookUseCase,
    // The webhook's polling counterpart, driving the same FinalizeOrderUseCase.
    ReconcileStaleOrdersUseCase,
    ReconciliationScheduler,
    ExpirePaymentSessionUseCase,
    OrderExpiredHandler,
  ],
  // OrderExpiredHandler is exported so the shared event consumer can route Order's expiry back here;
  // the gateway session it closes is Payment's to close, and only Payment can reach it.
  exports: [PAYMENT_REPOSITORY, WEBHOOK_EVENT_REPOSITORY, PAYMENT_GATEWAY, OrderExpiredHandler],
})
export class PaymentModule {}
