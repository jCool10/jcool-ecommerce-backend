import { Module } from '@nestjs/common';
import { PAYMENT_REPOSITORY } from './application/ports/payment-repository.port';
import { WEBHOOK_EVENT_REPOSITORY } from './application/ports/webhook-event-repository.port';
import { DrizzlePaymentRepository } from './infrastructure/payment.repository';
import { DrizzleWebhookEventRepository } from './infrastructure/webhook-event.repository';

/**
 * Payment bounded context: the "never double-charge" invariant. Owns payments +
 * webhook_events behind their repository ports. Session creation and the webhook endpoint
 * wire in later; this module registers the persistence adapters so the two tables have a
 * home and the context boots. No cross-context imports — the order id is a plain id, read
 * through a port when the flow needs it.
 */
@Module({
  providers: [
    { provide: PAYMENT_REPOSITORY, useClass: DrizzlePaymentRepository },
    { provide: WEBHOOK_EVENT_REPOSITORY, useClass: DrizzleWebhookEventRepository },
  ],
  exports: [PAYMENT_REPOSITORY, WEBHOOK_EVENT_REPOSITORY],
})
export class PaymentModule {}
