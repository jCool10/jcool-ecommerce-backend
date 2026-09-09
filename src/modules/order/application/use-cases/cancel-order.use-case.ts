import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { DrizzleTx } from '@shared/infrastructure/database/drizzle.tokens';
import { OrderStatus } from '../../domain/order-status';
import type { Order } from '../../domain/order.entity';
import { ORDER_REPOSITORY, type OrderRepositoryPort } from '../ports/order-repository.port';
import { toView, type OrderView } from '../order-view.mapper';
import { FinalizeOrderUseCase } from './finalize-order.use-case';

/**
 * Authorization runs under the same row lock as the finalize, which joins this transaction;
 * otherwise the order could settle some other way in between and this would answer 200 for a cancel
 * that never happened. Closing the gateway session is NOT done here — reaching the gateway would
 * hold that row lock for a network call; Payment reacts to `order.cancelled` instead.
 */
@Injectable()
export class CancelOrderUseCase {
  constructor(
    @Inject(ORDER_REPOSITORY) private readonly repo: OrderRepositoryPort,
    private readonly finalize: FinalizeOrderUseCase,
  ) {}

  cancelOwn(orderId: string, userId: string): Promise<OrderView> {
    return this.cancel(orderId, 'user:cancel', (order) => {
      // 404, not 403, for someone else's order: the same answer an id that does not exist gets, so
      // the endpoint cannot be used to discover which order ids are real.
      if (order.userId !== userId) {
        throw new NotFoundException(`Order not found: ${orderId}`);
      }
    });
  }

  cancelAsAdmin(orderId: string): Promise<OrderView> {
    return this.cancel(orderId, 'admin:cancel');
  }

  private async cancel(orderId: string, reason: string, authorize?: (order: Order) => void): Promise<OrderView> {
    const { view, report } = await this.repo.withTransaction<CancelOutcome>(async (tx: DrizzleTx) => {
      const order = await this.repo.findByIdForUpdate(orderId, tx);
      if (!order) {
        throw new NotFoundException(`Order not found: ${orderId}`);
      }
      authorize?.(order);

      // Re-cancelling is the same request answered again, not a conflict: a client that lost the
      // first response must be able to retry it.
      if (order.status === OrderStatus.CANCELLED) {
        return { view: toView(order) };
      }
      // Everything else refuses, PAID included — unwinding that is a refund, which this shop
      // does not do.
      if (order.status !== OrderStatus.PENDING) {
        throw new ConflictException(`Order cannot be cancelled in status ${order.status}`);
      }

      const result = await this.finalize.execute({ orderId, outcome: OrderStatus.CANCELLED, reason }, tx);
      if (result.status === 'finalized' || result.status === 'noop') {
        return { view: toView(result.order as Order), report: result.reportFinalized };
      }
      // Unreachable while the row lock holds, but if the finalize refuses anyway, answer from its
      // view of the order rather than the stale one above.
      throw new ConflictException(`Order cannot be cancelled in status ${result.order?.status ?? 'UNKNOWN'}`);
    });

    // The finalize joined the transaction above, so its counters and audit line only describe
    // something that happened once that transaction has committed.
    report?.();
    return view;
  }
}

interface CancelOutcome {
  view: OrderView;
  report?: () => void;
}
