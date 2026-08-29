import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { DrizzleTx } from '@shared/infrastructure/database/drizzle.tokens';
import { OUTBOX_WRITER, type OutboxWriterPort } from '@shared/messaging/outbox/outbox-writer.port';
import { METRICS, type CompensationTrigger, type MetricsPort } from '@shared/observability/metrics/metrics.port';
import { OrderStatus } from '../../domain/order-status';
import { canTransition } from '../../domain/order-state-machine';
import type { FinalizeOutcome } from '../../domain/order.entity';
import { ORDER_REPOSITORY, type OrderRepositoryPort } from '../ports/order-repository.port';
import { INVENTORY_RESERVATION, type InventoryReservationPort } from '../ports/inventory-reservation.port';
import { toFinalizedOutboxRecord } from '../order-outbox.mapper';
import type { FinalizeInput, FinalizeResult } from './finalize-order.types';

const LOG_CONTEXT = 'FinalizeOrder';

// PAID is absent because it commits the hold rather than releasing it — the one outcome that is not
// a rollback.
const COMPENSATION_TRIGGER: Readonly<Record<Exclude<FinalizeOutcome, typeof OrderStatus.PAID>, CompensationTrigger>> = {
  [OrderStatus.FAILED]: 'payment_failed',
  [OrderStatus.EXPIRED]: 'ttl_expired',
  [OrderStatus.CANCELLED]: 'cancelled',
};

/**
 * The one path that settles an order, shared by the webhook, the reconciliation sweep, and the
 * payment-settled consumer. Its exactly-once effect is a row lock plus a terminal guard, no
 * distributed lock — see docs/engineering-notes.md (Order). Callers must resolve the gateway BEFORE
 * calling: no network I/O may run inside this transaction, which holds the order's row lock.
 */
@Injectable()
export class FinalizeOrderUseCase {
  constructor(
    @Inject(ORDER_REPOSITORY) private readonly repo: OrderRepositoryPort,
    @Inject(INVENTORY_RESERVATION) private readonly inventory: InventoryReservationPort,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriterPort,
    @Inject(METRICS) private readonly metrics: MetricsPort,
    private readonly logger: PinoLogger,
  ) {}

  /**
   * `join` runs the whole unit in a transaction the caller already owns — how a consumer settles an
   * order under the same transaction as its inbox claim, so neither can commit without the other.
   */
  async execute(input: FinalizeInput, join?: DrizzleTx): Promise<FinalizeResult> {
    const result = await this.settle(input, join);
    if (result.status !== 'finalized') {
      return result; // a duplicate or a conflict moved nothing — see the counter's help text
    }

    const { orderId, outcome, reason } = input;
    // Recorded when the unit returns, which under `join` is before the caller's transaction commits.
    // A caller that rolls back after this leaves the counter one high and — the heavier claim — the
    // line below asserting an end state the database never reached; the redelivery then counts again.
    this.metrics.recordSagaStep('finalize', 'success');
    if (outcome !== OrderStatus.PAID) {
      this.metrics.recordCompensation(COMPENSATION_TRIGGER[outcome]);
    }
    // The one line that says an order reached its end state, and the only place the audit reason and
    // the outcome appear together. Every other settlement log here is a path that changed nothing.
    this.logger.info({ context: LOG_CONTEXT, orderId, outcome, reason }, 'order finalized');

    return result;
  }

  private async settle(
    { orderId, outcome, reason, paymentRef }: FinalizeInput,
    join?: DrizzleTx,
  ): Promise<FinalizeResult> {
    try {
      return await this.repo.withTransaction(async (tx) => {
        const order = await this.repo.findByIdForUpdate(orderId, tx);
        if (!order) {
          return { status: 'not_found' };
        }

        if (order.isTerminal()) {
          if (order.status === outcome) {
            return { status: 'noop', order }; // duplicate of the same outcome — no second effect, no second event
          }
          // Conflicting outcome on a settled order (e.g. a late `failed` after `paid`): drop it, never regress.
          this.logger.warn(
            { context: LOG_CONTEXT, orderId, current: order.status, incoming: outcome },
            'conflicting finalize ignored',
          );
          return { status: 'ignored', order };
        }

        // Still DRAFT, or any unwired source state: finalizing an unplaced order is illegal.
        if (!canTransition(order.status, outcome)) {
          return { status: 'ignored', order };
        }

        const finalized = order.finalize(outcome, { now: new Date(), reason, paymentRef });
        await this.repo.persistFinalization(finalized, tx);

        // Same tx as the status flip, so there is no window where an order is PAID but its stock is not.
        const resolution =
          outcome === OrderStatus.PAID
            ? await this.inventory.commit(tx, orderId)
            : await this.inventory.release(tx, orderId);
        if (!resolution.applied && !resolution.alreadyResolved) {
          // Not fatal, but it breaks the money = stock = status invariant, so a human has to look.
          this.logger.warn({ context: LOG_CONTEXT, orderId, outcome }, 'finalized order had no reservation to resolve');
        }

        // Same tx again: the settlement event cannot outlive a rolled-back finalize, and a committed
        // finalize cannot lose its event. Only this branch emits — a duplicate or conflicting outcome
        // already returned above, so the terminal guard doubles as the event's dedup.
        const event = finalized.toFinalizedEvent();
        await this.outbox.append(tx, toFinalizedOutboxRecord(event));

        return { status: 'finalized', order: finalized, event };
      }, join);
    } catch (error) {
      // Counted here or nowhere: a finalize that throws rolls its transaction back, and the queue
      // redelivery that follows can only ever be counted as a success.
      this.metrics.recordSagaStep('finalize', 'failed');
      throw error;
    }
  }
}
