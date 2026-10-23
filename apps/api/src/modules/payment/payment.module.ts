import { Module, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OrderModule } from '@modules/order/order.module';
import { CircuitBreakerFactory, ResilienceModule } from '@jcool/platform/resilience';
import { PAYMENT_REPOSITORY } from './application/ports/payment-repository.port';
import { WEBHOOK_EVENT_REPOSITORY } from './application/ports/webhook-event-repository.port';
import { PAYMENT_GATEWAY, type PaymentGatewayPort } from './application/ports/payment-gateway.port';
import { ORDER_READ_PORT } from './application/ports/order-read.port';
import { TRANSACTION_RUNNER } from './application/ports/transaction-runner.port';
import { PAYMENT_ORDER_REPOSITORY } from './application/ports/payment-order-repository.port';
import { PAYMENT_PARTICIPANT } from './application/public/payment-participant.port';
import { PaymentParticipantFacade } from './application/payment-participant.facade';
import {
  CancelPaymentUseCase,
  CapturePaymentUseCase,
  CreatePaymentSessionUseCase,
  ExpirePaymentSessionUseCase,
  HandlePaymentWebhookUseCase,
  OpenPaymentSessionUseCase,
  ProcessTccWebhookEventUseCase,
  ProcessWebhookEventUseCase,
  ReconcileStaleOrdersUseCase,
  ReconcileTccPaymentsUseCase,
  RecordAuthorizationUseCase,
  SweepWebhookEventsUseCase,
} from './application/use-cases';
import { DrizzlePaymentRepository } from './infrastructure/payment.repository';
import { DrizzlePaymentOrderRepository } from './infrastructure/payment-order.repository';
import { DrizzleWebhookEventRepository } from './infrastructure/webhook-event.repository';
import { DrizzleTransactionRunner } from './infrastructure/drizzle-transaction-runner';
import { OrderReadAdapter } from './infrastructure/order-read.adapter';
import { StripeGatewayAdapter } from './infrastructure/gateway/stripe-gateway.adapter';
import { isStripeUnavailable } from './infrastructure/gateway/stripe-fault-classification';
import {
  BreakerPaymentGateway,
  PAYMENT_CAPTURE_BREAKER,
  PAYMENT_GATEWAY_BREAKER,
} from './infrastructure/gateway/breaker-payment-gateway.adapter';
import { PaymentController } from './interface/payment.controller';
import { WebhookController } from './interface/webhook.controller';
import { ReconciliationScheduler } from './interface/reconciliation.scheduler';
import { OrderCancelledHandler } from './interface/queue/order-cancelled.handler';
import { OrderExpiredHandler } from './interface/queue/order-expired.handler';

// The gateway is fronted by a circuit breaker because it is the one dependency here that lives on
// someone else's network, so it is the one whose slowness can exhaust our request slots.
function createPaymentGateway(config: ConfigService, breakers: CircuitBreakerFactory): PaymentGatewayPort {
  const captureTimeoutMs = config.getOrThrow<number>('payment.captureTimeoutMs');
  const gateway = new StripeGatewayAdapter({
    webhookSecret: config.get<string>('payment.webhookSecret'),
    toleranceSec: config.get<number>('payment.webhookToleranceSec') ?? 300,
    secretKey: config.get<string>('payment.secretKey'),
    successUrl: config.get<string>('payment.successUrl'),
    cancelUrl: config.get<string>('payment.cancelUrl'),
    sessionMinTtlSec: config.getOrThrow<number>('payment.sessionMinTtlSec'),
    sessionExpiryMarginSec: config.getOrThrow<number>('payment.sessionExpiryMarginSec'),
    captureTimeoutMs,
  });
  const breaker = breakers.create(PAYMENT_GATEWAY_BREAKER, { isDownstreamFault: isStripeUnavailable });
  // A capture or void can spend up to 2T on the call plus its read-back; the shared 3s budget would
  // cut it off mid-flight and count a slow-but-healthy Stripe as an outage.
  const captureBreaker = breakers.create(PAYMENT_CAPTURE_BREAKER, {
    isDownstreamFault: isStripeUnavailable,
    timeoutMs: 2 * captureTimeoutMs + 1_000,
  });
  return new BreakerPaymentGateway(gateway, breaker, captureBreaker);
}

/**
 * Reads an order only through Order's published ORDER_PAYMENT_VIEW, behind Payment's own
 * ORDER_READ_PORT anti-corruption adapter, and settles one only through Order's exported
 * FinalizeOrderUseCase — never Order's tables.
 */
@Module({
  // forwardRef: Order imports this module back for the checkout saga's payment participant.
  imports: [forwardRef(() => OrderModule), ResilienceModule],
  controllers: [PaymentController, WebhookController],
  providers: [
    { provide: PAYMENT_REPOSITORY, useClass: DrizzlePaymentRepository },
    { provide: WEBHOOK_EVENT_REPOSITORY, useClass: DrizzleWebhookEventRepository },
    { provide: PAYMENT_GATEWAY, useFactory: createPaymentGateway, inject: [ConfigService, CircuitBreakerFactory] },
    { provide: ORDER_READ_PORT, useClass: OrderReadAdapter },
    { provide: TRANSACTION_RUNNER, useClass: DrizzleTransactionRunner },
    { provide: PAYMENT_ORDER_REPOSITORY, useClass: DrizzlePaymentOrderRepository },
    CreatePaymentSessionUseCase,
    ProcessWebhookEventUseCase,
    ProcessTccWebhookEventUseCase,
    HandlePaymentWebhookUseCase,
    ReconcileStaleOrdersUseCase,
    ReconcileTccPaymentsUseCase,
    ReconciliationScheduler,
    RecordAuthorizationUseCase,
    OpenPaymentSessionUseCase,
    CapturePaymentUseCase,
    CancelPaymentUseCase,
    { provide: PAYMENT_PARTICIPANT, useClass: PaymentParticipantFacade },
    ExpirePaymentSessionUseCase,
    // Registers itself with the shared retention registry on init; nothing here drives it.
    SweepWebhookEventsUseCase,
    OrderExpiredHandler,
    OrderCancelledHandler,
  ],
  // The queue handlers are exported so the shared event consumer can route Order's two unpaid endings
  // back here — only Payment can reach the session each one closes.
  exports: [
    PAYMENT_REPOSITORY,
    WEBHOOK_EVENT_REPOSITORY,
    PAYMENT_GATEWAY,
    PAYMENT_PARTICIPANT,
    OrderExpiredHandler,
    OrderCancelledHandler,
  ],
})
export class PaymentModule {}
