import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { OUTBOX_WRITER, type OutboxWriterPort } from '@shared/messaging/outbox/outbox-writer.port';
import { OrderStatus } from '../../domain/order-status';
import { canTransition } from '../../domain/order-state-machine';
import { ORDER_REPOSITORY, type OrderRepositoryPort } from '../ports/order-repository.port';
import { INVENTORY_RESERVATION, type InventoryReservationPort } from '../ports/inventory-reservation.port';
import { toFinalizedOutboxRecord } from '../order-outbox.mapper';
import type { FinalizeInput, FinalizeResult } from './finalize-order.types';

const LOG_CONTEXT = 'FinalizeOrder';

/**
 * The one path that settles an order, shared by the webhook and the reconciliation sweep. Its
 * exactly-once effect is a row lock plus a terminal guard, no distributed lock — see
 * docs/engineering-notes.md (Order). Callers must resolve the gateway BEFORE calling: no network I/O
 * may run inside this transaction, which holds the order's row lock.
 */
@Injectable()
export class FinalizeOrderUseCase {
  constructor(
    @Inject(ORDER_REPOSITORY) private readonly repo: OrderRepositoryPort,
    @Inject(INVENTORY_RESERVATION) private readonly inventory: InventoryReservationPort,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriterPort,
    private readonly logger: PinoLogger,
  ) {}

  async execute({ orderId, outcome, reason, paymentRef }: FinalizeInput): Promise<FinalizeResult> {
    return this.repo.withTransaction(async (tx) => {
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
    });
  }
}
