import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CircuitBreakerFactory, ResilienceModule } from '@jcool/platform/resilience';
import { PAYMENT_REPOSITORY } from './application/ports/payment-repository.port';
import { PAYMENT_ORDER_REPOSITORY } from './application/ports/payment-order-repository.port';
import { WEBHOOK_EVENT_REPOSITORY } from './application/ports/webhook-event-repository.port';
import { PAYMENT_GATEWAY, type PaymentGatewayPort } from './application/ports/payment-gateway.port';
import { TRANSACTION_RUNNER } from './application/ports/transaction-runner.port';
import { PAYMENT_PARTICIPANT } from './application/public/payment-participant.port';
import { PaymentParticipantFacade } from './application/payment-participant.facade';
import {
  ApplyTccWebhookEventUseCase,
  CancelPaymentUseCase,
  CapturePaymentUseCase,
  OpenPaymentSessionUseCase,
  ProcessWebhookEventUseCase,
  ReconcileTccPaymentsUseCase,
  RecordAuthorizationUseCase,
  SweepWebhookEventsUseCase,
} from './application/use-cases';
import { DrizzlePaymentRepository } from './infrastructure/payment.repository';
import { DrizzlePaymentOrderRepository } from './infrastructure/payment-order.repository';
import { DrizzleWebhookEventRepository } from './infrastructure/webhook-event.repository';
import { DrizzleTransactionRunner } from './infrastructure/drizzle-transaction-runner';
import { StripeGatewayAdapter } from './infrastructure/gateway/stripe-gateway.adapter';
import { isStripeUnavailable } from './infrastructure/gateway/stripe-fault-classification';
import { guardPaymentGateway } from './infrastructure/gateway/breaker-payment-gateway.adapter';
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
    sessionFloorSec:
      config.getOrThrow<number>('payment.sessionMinTtlSec') +
      config.getOrThrow<number>('payment.sessionExpiryMarginSec'),
    captureTimeoutMs,
  });
  return guardPaymentGateway(gateway, breakers, { captureTimeoutMs, isDownstreamFault: isStripeUnavailable });
}

/**
 * A participant in Order's checkout saga and nothing more: it knows no order, and reaches Order only
 * through the `payment.authorized` event it emits. Order drives it through PAYMENT_PARTICIPANT.
 */
@Module({
  imports: [ResilienceModule],
  controllers: [WebhookController],
  providers: [
    { provide: PAYMENT_REPOSITORY, useClass: DrizzlePaymentRepository },
    { provide: PAYMENT_ORDER_REPOSITORY, useClass: DrizzlePaymentOrderRepository },
    { provide: WEBHOOK_EVENT_REPOSITORY, useClass: DrizzleWebhookEventRepository },
    { provide: PAYMENT_GATEWAY, useFactory: createPaymentGateway, inject: [ConfigService, CircuitBreakerFactory] },
    { provide: TRANSACTION_RUNNER, useClass: DrizzleTransactionRunner },
    ProcessWebhookEventUseCase,
    ReconciliationScheduler,
    // Registers itself with the shared retention registry on init; nothing here drives it.
    SweepWebhookEventsUseCase,
    RecordAuthorizationUseCase,
    ApplyTccWebhookEventUseCase,
    OpenPaymentSessionUseCase,
    CapturePaymentUseCase,
    CancelPaymentUseCase,
    ReconcileTccPaymentsUseCase,
    { provide: PAYMENT_PARTICIPANT, useClass: PaymentParticipantFacade },
  ],
  exports: [PAYMENT_REPOSITORY, WEBHOOK_EVENT_REPOSITORY, PAYMENT_GATEWAY, PAYMENT_PARTICIPANT],
})
export class PaymentModule {}
