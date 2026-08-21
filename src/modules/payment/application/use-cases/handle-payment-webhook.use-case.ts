import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { FinalizeOrderUseCase } from '@modules/order/application/use-cases';
import { mapPaymentToOrderOutcome } from '../mappers/map-payment-to-order-outcome';
import { ProcessWebhookEventUseCase, type WebhookProcessResult } from './process-webhook-event.use-case';

const LOG_CONTEXT = 'HandlePaymentWebhook';

/**
 * Webhook orchestrator across the Payment↔Order boundary: verify+dedup+settle the payment
 * (ProcessWebhookEventUseCase, in its own tx), then finalize the order to the matching terminal
 * state. Finalize runs ONLY when the payment actually settled this delivery (`processed`) — a
 * duplicate/ignored/skipped delivery already drove (or intentionally didn't) the order, so it must
 * not fire again.
 *
 * The two run in SEPARATE transactions on purpose: Payment and Order are independent state machines,
 * and finalize (lock + terminal guard + stock) owns its own unit of work — the same one the
 * reconciliation cron calls. The cost is a narrow window where the payment is PROCESSED but the order
 * finalize hasn't landed; the cron closes it, and the gateway never sees that gap (it gets a 2xx).
 * Cross-context atomicity via an outbox is deliberately deferred (next week).
 */
@Injectable()
export class HandlePaymentWebhookUseCase {
  constructor(
    private readonly processEvent: ProcessWebhookEventUseCase,
    private readonly finalizeOrder: FinalizeOrderUseCase,
    private readonly logger: PinoLogger,
  ) {}

  async execute(rawBody: Buffer, headers: Record<string, string>): Promise<WebhookProcessResult> {
    const result = await this.processEvent.execute(rawBody, headers);
    // Only a first-delivery settle finalizes the order; every other outcome (rejected/duplicate/
    // ignored/skipped) leaves it untouched — the payment side already decided nothing new applies.
    if (result.outcome !== 'processed') {
      return result;
    }

    const outcome = mapPaymentToOrderOutcome(result.status);
    if (outcome === null) {
      // Unreachable today (a settled payment is SUCCEEDED or FAILED, both mapped), but guard the
      // money path: a future settled status must never leave a paid order un-finalized without a trace.
      this.logger.warn(
        { context: LOG_CONTEXT, orderId: result.orderId, status: result.status },
        'settled payment status maps to no order outcome — order not finalized',
      );
      return result;
    }

    // Finalize in FinalizeOrderUseCase's OWN tx, AFTER the payment tx committed. On throw the payment
    // is already durably PROCESSED and a gateway retry would only dedup (never re-drive finalize), so
    // we log and still ack 2xx, leaving the order for the reconciliation cron. A 5xx here buys nothing
    // but a retry storm.
    try {
      const finalize = await this.finalizeOrder.execute({
        orderId: result.orderId,
        outcome,
        paymentRef: result.paymentRef,
        reason: `webhook:${result.eventType}`,
      });
      if (finalize.status === 'not_found' || finalize.status === 'ignored') {
        // Payment settled but the order didn't move to the matching state (missing, or already
        // terminal on a conflicting outcome) — a money=status mismatch for the cron to resolve.
        this.logger.warn(
          { context: LOG_CONTEXT, orderId: result.orderId, outcome, finalize: finalize.status },
          'payment settled but order finalize was a no-op — reconciliation will confirm',
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        { context: LOG_CONTEXT, orderId: result.orderId, outcome },
        `order finalize failed after payment settled — order left for reconciliation cron: ${message}`,
      );
    }

    return result;
  }
}
