import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { DrizzleTx } from '@shared/infrastructure/database/drizzle.tokens';
import { PermanentError } from '@shared/messaging/errors';
import type { DomainEventJob, PostCommitEffect } from '@shared/messaging/queue/domain-event.job';
import { METRICS, type MetricsPort } from '@shared/observability/metrics/metrics.port';
import { FinalizeOrderUseCase, type FinalizeOutcome } from '../../application/use-cases';

const LOG_CONTEXT = 'PaymentEventsHandler';

/**
 * The anti-corruption step that keeps Payment from naming order outcomes. An expired session settles
 * the payment as failed, so there is no event here for order EXPIRED: that outcome belongs to the
 * reservation sweep alone.
 */
const OUTCOME_BY_EVENT: Readonly<Record<string, FinalizeOutcome>> = {
  'payment.succeeded': 'PAID',
  'payment.failed': 'FAILED',
};

/**
 * Order coordinates the checkout saga, so the outcome decision lives here — Payment publishes that a
 * payment settled and stops there. The webhook also finalizes in-process for latency; this path is
 * the guaranteed one, its event written in the settlement's transaction and redelivered until it
 * lands.
 */
@Injectable()
export class PaymentEventsHandler {
  constructor(
    private readonly finalizeOrder: FinalizeOrderUseCase,
    @Inject(METRICS) private readonly metrics: MetricsPort,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(LOG_CONTEXT);
  }

  async settle(job: DomainEventJob, tx: DrizzleTx): Promise<PostCommitEffect | void> {
    const outcome = OUTCOME_BY_EVENT[job.eventType];
    const orderId = job.payload.orderId;
    // Permanent, not retryable: a payload this shape will be identical on every redelivery, and a
    // guessed orderId would settle the wrong order.
    if (outcome === undefined || typeof orderId !== 'string') {
      throw new PermanentError(`Unusable payment settlement event "${job.eventType}"`);
    }

    // The consumer's transaction, which also holds the inbox claim: a finalize that throws takes the
    // claim with it, so the redelivery settles the order for real instead of finding it consumed.
    const result = await this.finalizeOrder.execute(
      { orderId, outcome, paymentRef: readPaymentRef(job.payload), reason: `event:${job.eventType}` },
      tx,
    );

    // Both are acknowledged rather than retried: no redelivery conjures an order or reopens a
    // terminal one, and the money has already moved.
    if (result.status === 'not_found') {
      // Loud, because a settled payment with no order to settle is a refund decision.
      if (outcome === 'PAID') this.metrics.recordRefundOwed('settlement_event');
      this.logger.error(
        { orderId, eventType: job.eventType, messageId: job.outboxId },
        'payment settled for an order that does not exist',
      );
    } else if (result.status === 'ignored') {
      // The order settled some other way first — the sweep expiring it, or a buyer cancelling it. A
      // successful payment onto that is the same refund decision; a failed one is the benign tail.
      if (outcome === 'PAID') this.metrics.recordRefundOwed('settlement_event');
      const level = outcome === 'PAID' ? 'error' : 'info';
      this.logger[level](
        { orderId, eventType: job.eventType, status: result.order?.status },
        'payment settled for an order that was already in a terminal state',
      );
    }

    // The settlement is written to the consumer's transaction, so it only becomes true once that
    // commits — the finalize hands back its counters and audit line for this consumer to run then.
    const report = result.reportFinalized;
    if (report) {
      return () => Promise.resolve(report());
    }
  }
}

function readPaymentRef(payload: Record<string, unknown>): string | null {
  return typeof payload.paymentRef === 'string' ? payload.paymentRef : null;
}
