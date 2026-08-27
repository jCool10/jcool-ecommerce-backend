import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { DrizzleTx } from '@shared/infrastructure/database/drizzle.tokens';
import { PermanentError } from '@shared/messaging/errors';
import type { DomainEventJob } from '@shared/messaging/queue/domain-event.job';
import { FinalizeOrderUseCase, type FinalizeOutcome } from '../../application/use-cases';

const LOG_CONTEXT = 'PaymentEventsHandler';

/**
 * Payment's settlement events read in Order's own vocabulary — the anti-corruption step that keeps
 * Payment from naming order outcomes. An expired session settles the payment as failed, so there is
 * no event here for order EXPIRED: that outcome belongs to the reservation sweep alone.
 */
const OUTCOME_BY_EVENT: Readonly<Record<string, FinalizeOutcome>> = {
  'payment.succeeded': 'PAID',
  'payment.failed': 'FAILED',
};

/**
 * The order half of the checkout saga: Order reacts to what the money did and settles itself.
 *
 * Order is the saga's coordinator, so the decision lives here rather than in Payment — Payment
 * publishes that a payment settled and stops there. The webhook also finalizes directly, in-process,
 * for latency; this path is the one that is guaranteed to happen, because its event was written in
 * the same transaction as the settlement and the queue keeps redelivering until it lands.
 */
@Injectable()
export class PaymentEventsHandler {
  constructor(
    private readonly finalizeOrder: FinalizeOrderUseCase,
    private readonly logger: PinoLogger,
  ) {}

  async settle(job: DomainEventJob, tx: DrizzleTx): Promise<void> {
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

    if (result.status === 'not_found') {
      // Acknowledged rather than retried: no redelivery conjures an order, and the money has already
      // moved. Loud, because a settled payment with no order to settle is a refund decision.
      this.logger.error(
        { context: LOG_CONTEXT, orderId, eventType: job.eventType, messageId: job.outboxId },
        'payment settled for an order that does not exist',
      );
    }
  }
}

function readPaymentRef(payload: Record<string, unknown>): string | null {
  return typeof payload.paymentRef === 'string' ? payload.paymentRef : null;
}
