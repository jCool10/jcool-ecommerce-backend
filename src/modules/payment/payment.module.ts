import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OrderModule } from '@modules/order/order.module';
import { PAYMENT_REPOSITORY } from './application/ports/payment-repository.port';
import { WEBHOOK_EVENT_REPOSITORY } from './application/ports/webhook-event-repository.port';
import { PAYMENT_GATEWAY, type PaymentGatewayPort } from './application/ports/payment-gateway.port';
import { ORDER_READ_PORT } from './application/ports/order-read.port';
import { TRANSACTION_RUNNER } from './application/ports/transaction-runner.port';
import { CreatePaymentSessionUseCase } from './application/create-payment-session.use-case';
import { ProcessWebhookEventUseCase } from './application/process-webhook-event.use-case';
import { DrizzlePaymentRepository } from './infrastructure/payment.repository';
import { DrizzleWebhookEventRepository } from './infrastructure/webhook-event.repository';
import { DrizzleTransactionRunner } from './infrastructure/drizzle-transaction-runner';
import { OrderReadAdapter } from './infrastructure/order-read.adapter';
import { StripeGatewayAdapter } from './infrastructure/gateway/stripe-gateway.adapter';
import { SepayGatewayAdapter } from './infrastructure/gateway/sepay-gateway.adapter';
import { PaymentController } from './interface/payment.controller';
import { WebhookController } from './interface/webhook.controller';

// Provider selected by env; changing gateways is an env + inject change, never a caller change.
// Stripe is the coded path (see StripeGatewayAdapter); SePay is an interface-only seam.
function createPaymentGateway(config: ConfigService): PaymentGatewayPort {
  if (config.get<string>('payment.provider') === 'sepay') {
    return new SepayGatewayAdapter();
  }
  return new StripeGatewayAdapter({
    webhookSecret: config.get<string>('payment.webhookSecret'),
    toleranceSec: config.get<number>('payment.webhookToleranceSec') ?? 300,
    secretKey: config.get<string>('payment.secretKey'),
    successUrl: config.get<string>('payment.successUrl'),
    cancelUrl: config.get<string>('payment.cancelUrl'),
  });
}

/**
 * Payment bounded context: the "never double-charge" invariant. Owns payments +
 * webhook_events behind their repository ports, and the gateway port that session creation and
 * webhook verify depend on. Reads an order only through Order's published ORDER_PAYMENT_VIEW
 * (via OrderModule), behind Payment's own ORDER_READ_PORT anti-corruption adapter — never Order's
 * table. `POST /orders/:id/pay` opens a session and persists a PENDING Payment; it does not
 * finalize the order.
 */
@Module({
  imports: [OrderModule],
  controllers: [PaymentController, WebhookController],
  providers: [
    { provide: PAYMENT_REPOSITORY, useClass: DrizzlePaymentRepository },
    { provide: WEBHOOK_EVENT_REPOSITORY, useClass: DrizzleWebhookEventRepository },
    { provide: PAYMENT_GATEWAY, useFactory: createPaymentGateway, inject: [ConfigService] },
    { provide: ORDER_READ_PORT, useClass: OrderReadAdapter },
    { provide: TRANSACTION_RUNNER, useClass: DrizzleTransactionRunner },
    CreatePaymentSessionUseCase,
    ProcessWebhookEventUseCase,
  ],
  exports: [PAYMENT_REPOSITORY, WEBHOOK_EVENT_REPOSITORY, PAYMENT_GATEWAY],
})
export class PaymentModule {}
