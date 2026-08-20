import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { OrderStatus } from '../../domain/order-status';
import { canTransition } from '../../domain/order-state-machine';
import { ORDER_REPOSITORY, type OrderRepositoryPort } from '../ports/order-repository.port';
import { INVENTORY_RESERVATION, type InventoryReservationPort } from '../ports/inventory-reservation.port';
import type { FinalizeInput, FinalizeResult } from './finalize-order.types';

const LOG_CONTEXT = 'FinalizeOrder';

/**
 * Finalize an order to a terminal outcome (PENDING → PAID/FAILED/EXPIRED) with an exactly-once
 * effect, so a duplicated or out-of-order webhook — or a webhook racing the reconcile cron — settles
 * the order at most once and never regresses it.
 *
 * Idempotency = row lock + terminal guard, no distributed lock: one transaction locks the order
 * (`findByIdForUpdate` → SELECT … FOR UPDATE) to serialize concurrent finalizers, then a terminal
 * check decides the branch — re-applying the same outcome is a benign no-op, a conflicting one is
 * ignored (logged for reconciliation), and only a genuine PENDING → outcome transition mutates state
 * and produces the domain event. No network I/O runs inside the transaction (that would hold the lock);
 * a gateway is queried only outside it, then the confirmed outcome is passed here.
 */
@Injectable()
export class FinalizeOrderUseCase {
  constructor(
    @Inject(ORDER_REPOSITORY) private readonly repo: OrderRepositoryPort,
    @Inject(INVENTORY_RESERVATION) private readonly inventory: InventoryReservationPort,
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

      // Not PENDING (still DRAFT, or any non-wired source): finalizing an unplaced order is illegal — skip safely.
      if (!canTransition(order.status, outcome)) {
        return { status: 'ignored', order };
      }

      const finalized = order.finalize(outcome, { now: new Date(), reason, paymentRef });
      await this.repo.persistFinalization(finalized, tx);

      // Resolve stock in this same tx so order state and stock commit or roll back together (no
      // PAID-but-unpinned window): PAID commits the hold (on-hand drops), FAILED/EXPIRED releases it.
      const resolution =
        outcome === OrderStatus.PAID
          ? await this.inventory.commit(tx, orderId)
          : await this.inventory.release(tx, orderId);
      if (!resolution.applied && !resolution.alreadyResolved) {
        // Settled an order with no stock hold (predates reservations, or the hold was lost). Not fatal —
        // the order still finalizes — but it breaks the money=stock=status invariant, so flag for reconcile.
        this.logger.warn({ context: LOG_CONTEXT, orderId, outcome }, 'finalized order had no reservation to resolve');
      }

      // SEAM (outbox): append `finalized.toFinalizedEvent()` to an outbox table in this same tx; a relay publishes it.
      return { status: 'finalized', order: finalized, event: finalized.toFinalizedEvent() };
    });
  }
}
