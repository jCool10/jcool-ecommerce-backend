import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { toError } from '@jcool/kernel';
import { ID_GENERATOR, mintOne, type IdGeneratorPort } from '@shared/identity/id-generator.port';
import { onCancelRequested, type SagaTransition } from '../../domain/checkout-saga';
import type { Order } from '../../domain/order.entity';
import { BUYER_HIDDEN_STATUSES, OrderStatus } from '../../domain/order-status';
import { toView, type OrderView } from '../order-view.mapper';
import { CHECKOUT_SAGA_REPOSITORY, type CheckoutSagaRepositoryPort } from '../ports/checkout-saga-repository.port';
import { ORDER_REPOSITORY, type OrderRepositoryPort } from '../ports/order-repository.port';
import { CheckoutSagaWriter } from '../saga/checkout-saga.writer';
import { AdvanceCheckoutSagaUseCase } from './advance-checkout-saga.use-case';

const LOG_CONTEXT = 'CancelOrder';

/**
 * Authorization runs under the order's row lock, the same one the cancel is written under, so the
 * order cannot settle some other way in between. The compensation runs after commit, awaited because
 * this is a request rather than a queue slot; if it fails the runner finishes it, and the cancel stands.
 */
@Injectable()
export class CancelOrderUseCase {
  constructor(
    @Inject(ORDER_REPOSITORY) private readonly orders: OrderRepositoryPort,
    @Inject(CHECKOUT_SAGA_REPOSITORY) private readonly sagas: CheckoutSagaRepositoryPort,
    private readonly writer: CheckoutSagaWriter,
    private readonly advance: AdvanceCheckoutSagaUseCase,
    @Inject(ID_GENERATOR) private readonly ids: IdGeneratorPort,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(LOG_CONTEXT);
  }

  cancelOwn(orderId: string, userId: string): Promise<OrderView> {
    return this.cancel(orderId, 'user', (order) => {
      // 404, not 403: the same answer an id that does not exist gets, so the endpoint cannot be used
      // to discover which order ids are real, nor see an order the buyer's own reads hide.
      if (order.userId !== userId || BUYER_HIDDEN_STATUSES.includes(order.status)) {
        throw new NotFoundException(`Order not found: ${orderId}`);
      }
    });
  }

  cancelAsAdmin(orderId: string): Promise<OrderView> {
    return this.cancel(orderId, 'admin');
  }

  private async cancel(orderId: string, by: 'user' | 'admin', authorize?: (order: Order) => void): Promise<OrderView> {
    // Before the transaction, so no row lock waits on the id service. A repeat cancel wastes it.
    const eventId = await mintOne(this.ids);
    const { view, transition } = await this.orders.withTransaction(async (tx) => {
      const order = await this.orders.findByIdForUpdate(orderId, tx);
      if (!order) throw new NotFoundException(`Order not found: ${orderId}`);
      authorize?.(order);

      // Re-cancelling is the same request answered again, not a conflict: a client that lost the
      // first response must be able to retry it.
      if (order.status === OrderStatus.CANCELLED) return { view: toView(order), transition: null };
      // CONFIRMING included: the money is already being taken, and unwinding that is a refund.
      if (order.status !== OrderStatus.PENDING) {
        throw new ConflictException(`Order cannot be cancelled in status ${order.status}`);
      }
      const saga = await this.sagas.findForUpdate(tx, orderId);
      if (!saga) throw new Error(`Pending order ${orderId} has no checkout saga`);

      const cancelling: SagaTransition = onCancelRequested(saga, by);
      const cancelled = await this.writer.rewrite(tx, order, saga, cancelling, { now: new Date(), eventId });
      return { view: toView(cancelled), transition: cancelling };
    });

    if (transition) {
      this.writer.reportCommitted(transition);
      this.logger.info({ orderId, by }, 'order cancelled');
      await this.advance.execute(orderId).catch((error: unknown) => {
        this.logger.error({ err: toError(error), orderId }, 'cancel compensation failed; the runner takes it over');
      });
    }
    return view;
  }
}
