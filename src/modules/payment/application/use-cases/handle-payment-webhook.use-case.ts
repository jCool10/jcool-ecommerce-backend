import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { FinalizeOrderUseCase } from '@modules/order/application/use-cases';
import { METRICS, type MetricsPort } from '@shared/observability/metrics/metrics.port';
import { PaymentStatus } from '../../domain/payment-status';
import { mapPaymentToOrderOutcome } from '../mappers/map-payment-to-order-outcome';
import { ProcessWebhookEventUseCase, type WebhookProcessResult } from './process-webhook-event.use-case';

const LOG_CONTEXT = 'HandlePaymentWebhook';

/**
 * Payment and order settle in two SEPARATE transactions. The finalize here is a latency optimization,
 * not the guarantee: the payment transaction also emitted a settlement event whose consumer settles
 * the same order idempotently, so the window left open closes within a relay tick.
 */
@Injectable()
export class HandlePaymentWebhookUseCase {
  constructor(
    private readonly processEvent: ProcessWebhookEventUseCase,
    private readonly finalizeOrder: FinalizeOrderUseCase,
    @Inject(METRICS) private readonly metrics: MetricsPort,
    private readonly logger: PinoLogger,
  ) {}

  async execute(rawBody: Buffer, headers: Record<string, string>): Promise<WebhookProcessResult> {
    const result = await this.processEvent.execute(rawBody, headers);
    // Only a first-delivery settle finalizes: on any other outcome the payment side already decided.
    if (result.outcome !== 'processed') {
      if (result.outcome === 'skipped' && result.conflict?.to === PaymentStatus.SUCCEEDED) {
        // Money moved on a payment we had already closed. A refund decision, not a retry.
        this.metrics.recordRefundOwed('webhook_direct');
        this.logger.error(
          { context: LOG_CONTEXT, ...result.conflict },
          'gateway reported a success on an already-settled payment — funds may be captured with no matching order',
        );
      }
      if (result.outcome === 'skipped' && result.charge) {
        // The signature was ours, the charge was not. Deliberately left unsettled for a human.
        this.logger.error(
          { context: LOG_CONTEXT, ...result.charge },
          'gateway reported a charge that does not match the recorded payment — payment left unsettled for manual review',
        );
      }
      return result;
    }

    const outcome = mapPaymentToOrderOutcome(result.status);
    if (outcome === null) {
      // Unreachable today, but a future settled status must never strand a paid order silently.
      this.logger.warn(
        { context: LOG_CONTEXT, orderId: result.orderId, status: result.status },
        'settled payment status maps to no order outcome — order not finalized',
      );
      return result;
    }

    // The payment tx has already committed, so a gateway retry would dedup and never re-drive this.
    // Ack 2xx even on failure and leave the order to the sweep; a 5xx buys only a retry storm.
    try {
      const finalize = await this.finalizeOrder.execute({
        orderId: result.orderId,
        outcome,
        paymentRef: result.paymentRef,
        reason: `webhook:${result.eventType}`,
      });
      if (finalize.status === 'not_found' || finalize.status === 'ignored') {
        // Not something a sweep will pick up: reconcile's queue is orders still PENDING, and this
        // one is either gone or already terminal. The durable settlement event re-runs the same
        // finalize and counts it again — which is why the metric counts observations, not refunds.
        if (outcome === 'PAID') this.metrics.recordRefundOwed('webhook_direct');
        const level = outcome === 'PAID' ? 'error' : 'warn';
        this.logger[level](
          { context: LOG_CONTEXT, orderId: result.orderId, outcome, finalize: finalize.status },
          'payment settled but the order did not move',
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        { context: LOG_CONTEXT, orderId: result.orderId, outcome },
        `order finalize failed after payment settled — settlement event will settle it: ${message}`,
      );
    }

    return result;
  }
}
