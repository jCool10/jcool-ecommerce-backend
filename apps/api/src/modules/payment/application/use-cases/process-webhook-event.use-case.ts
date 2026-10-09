import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { METRICS, type MetricsPort } from '@jcool/metrics-port';
import { ID_GENERATOR, mintOne, type IdGeneratorPort } from '@shared/identity/id-generator.port';
import type { Payment } from '../../domain/payment.entity';
import { PAYMENT_GATEWAY, type PaymentGatewayPort, type VerifiedEvent } from '../ports/payment-gateway.port';
import { PAYMENT_ORDER_REPOSITORY, type PaymentOrderRepositoryPort } from '../ports/payment-order-repository.port';
import { PAYMENT_REPOSITORY, type PaymentRepositoryPort } from '../ports/payment-repository.port';
import { WEBHOOK_EVENT_REPOSITORY, type WebhookEventRepositoryPort } from '../ports/webhook-event-repository.port';
import { TRANSACTION_RUNNER, type TransactionRunnerPort } from '../ports/transaction-runner.port';
import { readCheckoutSession } from '../mappers/read-checkout-session';
import { ApplyTccWebhookEventUseCase } from './apply-tcc-webhook-event.use-case';
import type { WebhookProcessResult } from './webhook-process-result';

export type { WebhookProcessResult } from './webhook-process-result';

type ValidEvent = Extract<VerifiedEvent, { kind: 'valid' }>;

const LOG_CONTEXT = 'ProcessWebhookEvent';
const SESSION_EVENTS = new Set(['checkout.session.completed', 'checkout.session.expired']);

/**
 * Only a payment opened behind a `payment_orders` header is acted on; every other delivery is logged
 * so a redelivery dedups, and nothing else. The idempotency insert and whatever the event changes
 * share one transaction: split them, and a crash in between leaves the redelivery no-oping forever.
 */
@Injectable()
export class ProcessWebhookEventUseCase {
  constructor(
    @Inject(TRANSACTION_RUNNER) private readonly txRunner: TransactionRunnerPort,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGatewayPort,
    @Inject(WEBHOOK_EVENT_REPOSITORY) private readonly webhookEvents: WebhookEventRepositoryPort,
    @Inject(PAYMENT_REPOSITORY) private readonly payments: PaymentRepositoryPort,
    @Inject(PAYMENT_ORDER_REPOSITORY) private readonly paymentOrders: PaymentOrderRepositoryPort,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGeneratorPort,
    private readonly applyTccEvent: ApplyTccWebhookEventUseCase,
    @Inject(METRICS) private readonly metrics: MetricsPort,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(LOG_CONTEXT);
  }

  async execute(rawBody: Buffer, headers: Record<string, string>): Promise<WebhookProcessResult> {
    // Verify BEFORE any DB write — a forged or replayed body must never reach the event log.
    const verified = this.gateway.verifyAndParseEvent(rawBody, headers);
    if (verified.kind !== 'valid') return { outcome: 'rejected', reason: verified.kind };

    const payment = await this.findSessionPayment(verified);
    const result =
      payment !== null && (await this.paymentOrders.find(payment.orderId)) !== null
        ? await this.applyTccEvent.execute(verified, payment)
        : await this.logUnapplied(verified, payment);
    this.report(result);
    return result;
  }

  private async findSessionPayment(event: ValidEvent): Promise<Payment | null> {
    if (!SESSION_EVENTS.has(event.type)) return null;
    const { sessionId } = readCheckoutSession(event.payload);
    return sessionId ? this.payments.findByProviderSessionId(sessionId) : null;
  }

  private async logUnapplied(event: ValidEvent, payment: Payment | null): Promise<WebhookProcessResult> {
    const delivery = { providerEventId: event.providerEventId, eventType: event.type };
    const eventId = await mintOne(this.idGenerator);

    return this.txRunner.run(async (tx) => {
      const { inserted } = await this.webhookEvents.insertIfNew(
        {
          provider: this.gateway.provider,
          providerEventId: event.providerEventId,
          type: event.type,
          payload: event.payload,
        },
        tx,
        eventId,
      );
      if (!inserted) return { outcome: 'duplicate', ...delivery };
      if (!SESSION_EVENTS.has(event.type)) return { outcome: 'ignored', ...delivery };

      await this.webhookEvents.markSkipped(eventId, tx);
      if (payment === null) return { outcome: 'skipped', reason: 'payment_not_found', ...delivery };
      return {
        outcome: 'skipped',
        reason: 'unfenced',
        ...delivery,
        orderId: payment.orderId,
        captured: isCapture(event),
      };
    });
  }

  private report(result: WebhookProcessResult): void {
    switch (result.outcome) {
      case 'unavailable':
        this.logger.warn({ ...delivery(result) }, 'gateway unreadable — webhook left for redelivery');
        return;
      case 'duplicate':
      case 'ignored':
        this.logger.debug({ outcome: result.outcome, ...delivery(result) }, 'webhook event accepted but not applied');
        return;
      case 'skipped':
        if (result.reason === 'unfenced' && result.captured) {
          this.metrics.recordRefundOwed('webhook_direct');
          this.logger.error(
            { orderId: result.orderId, ...delivery(result) },
            'gateway captured a session no checkout saga owns — refund owed',
          );
          return;
        }
        this.logger.info(
          { outcome: result.outcome, reason: result.reason, ...delivery(result) },
          'webhook event accepted but not applied',
        );
    }
  }
}

// `no_payment_required` is a fully discounted session: it completes without moving any money.
function isCapture(event: ValidEvent): boolean {
  return event.type === 'checkout.session.completed' && readCheckoutSession(event.payload).paymentStatus === 'paid';
}

function delivery(result: { providerEventId: string; eventType: string }) {
  return { providerEventId: result.providerEventId, eventType: result.eventType };
}
