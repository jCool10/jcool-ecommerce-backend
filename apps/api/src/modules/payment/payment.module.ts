import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CircuitBreakerFactory, ResilienceModule } from '@jcool/platform/resilience';
import { PAYMENT_REPOSITORY } from './application/ports/payment-repository.port';
import { WEBHOOK_EVENT_REPOSITORY } from './application/ports/webhook-event-repository.port';
import { PAYMENT_GATEWAY, type PaymentGatewayPort } from './application/ports/payment-gateway.port';
import { TRANSACTION_RUNNER } from './application/ports/transaction-runner.port';
import { PAYMENT_ORDER_REPOSITORY } from './application/ports/payment-order-repository.port';
import { PAYMENT_PARTICIPANT } from './application/public/payment-participant.port';
import { PaymentParticipantFacade } from './application/payment-participant.facade';
import {
  CancelPaymentUseCase,
  CapturePaymentUseCase,
  HandlePaymentWebhookUseCase,
  OpenPaymentSessionUseCase,
  ProcessTccWebhookEventUseCase,
  ProcessWebhookEventUseCase,
  ReconcileTccPaymentsUseCase,
  RecordAuthorizationUseCase,
  SweepWebhookEventsUseCase,
} from './application/use-cases';
import { DrizzlePaymentRepository } from './infrastructure/payment.repository';
import { DrizzlePaymentOrderRepository } from './infrastructure/payment-order.repository';
import { DrizzleWebhookEventRepository } from './infrastructure/webhook-event.repository';
import { DrizzleTransactionRunner } from './infrastructure/drizzle-transaction-runner';
import { PAYMENT_AUTHORIZATION_COLLECTOR_PROVIDERS } from './infrastructure/payment-authorization.collector';
import { StripeGatewayAdapter } from './infrastructure/gateway/stripe-gateway.adapter';
import { isStripeUnavailable } from './infrastructure/gateway/stripe-fault-classification';
import {
  BreakerPaymentGateway,
  PAYMENT_CAPTURE_BREAKER,
  PAYMENT_GATEWAY_BREAKER,
} from './infrastructure/gateway/breaker-payment-gateway.adapter';
import { WebhookController } from './interface/webhook.controller';
import { ReconciliationScheduler } from './interface/reconciliation.scheduler';

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

/** Knows nothing about orders: the checkout saga drives it through PAYMENT_PARTICIPANT. */
@Module({
  imports: [ResilienceModule],
  controllers: [WebhookController],
  providers: [
    { provide: PAYMENT_REPOSITORY, useClass: DrizzlePaymentRepository },
    { provide: WEBHOOK_EVENT_REPOSITORY, useClass: DrizzleWebhookEventRepository },
    { provide: PAYMENT_GATEWAY, useFactory: createPaymentGateway, inject: [ConfigService, CircuitBreakerFactory] },
    { provide: TRANSACTION_RUNNER, useClass: DrizzleTransactionRunner },
    { provide: PAYMENT_ORDER_REPOSITORY, useClass: DrizzlePaymentOrderRepository },
    ProcessWebhookEventUseCase,
    ProcessTccWebhookEventUseCase,
    HandlePaymentWebhookUseCase,
    ReconcileTccPaymentsUseCase,
    ReconciliationScheduler,
    RecordAuthorizationUseCase,
    OpenPaymentSessionUseCase,
    CapturePaymentUseCase,
    CancelPaymentUseCase,
    { provide: PAYMENT_PARTICIPANT, useClass: PaymentParticipantFacade },
    ...PAYMENT_AUTHORIZATION_COLLECTOR_PROVIDERS,
    // Registers itself with the shared retention registry on init; nothing here drives it.
    SweepWebhookEventsUseCase,
  ],
  exports: [PAYMENT_REPOSITORY, WEBHOOK_EVENT_REPOSITORY, PAYMENT_GATEWAY, PAYMENT_PARTICIPANT],
})
export class PaymentModule {}
