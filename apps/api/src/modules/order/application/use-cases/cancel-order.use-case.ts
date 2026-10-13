import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { Order } from '../../domain/order.entity';
import { BUYER_HIDDEN_STATUSES, OrderStatus } from '../../domain/order-status';
import { CheckoutUnavailableException } from '../checkout-unavailable.exception';
import { toView, type OrderView } from '../order-view.mapper';
import {
  CHECKOUT_SAGA_ENGINE,
  CheckoutEngineUnavailableError,
  CheckoutNotCancellableError,
  type CheckoutSagaEnginePort,
} from '../ports/checkout-saga-engine.port';
import { ORDER_REPOSITORY, type OrderRepositoryPort } from '../ports/order-repository.port';
import { CHECKOUT_SAGA_SETTINGS, type CheckoutSagaSettings } from '../saga/checkout-saga.settings';

const LOG_CONTEXT = 'CancelOrder';

/**
 * The saga decides: its cancel update is refused once an authorization has arrived, even if the
 * order row still reads PENDING. The answer waits for the compensation, bounded by the saga.
 */
@Injectable()
export class CancelOrderUseCase {
  private readonly retryAfterSec: number;

  constructor(
    @Inject(ORDER_REPOSITORY) private readonly orders: OrderRepositoryPort,
    @Inject(CHECKOUT_SAGA_ENGINE) private readonly engine: CheckoutSagaEnginePort,
    @Inject(CHECKOUT_SAGA_SETTINGS) settings: CheckoutSagaSettings,
    private readonly logger: PinoLogger,
  ) {
    this.retryAfterSec = Math.max(1, Math.ceil(settings.cancelWaitMs / 1000));
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
    const order = await this.orders.findById(orderId);
    if (!order) throw new NotFoundException(`Order not found: ${orderId}`);
    authorize?.(order);
    // Re-cancelling is the same request answered again, not a conflict: a client that lost the
    // first response must be able to retry it.
    if (order.status === OrderStatus.CANCELLED) return toView(order);
    if (order.status !== OrderStatus.PENDING) throw notCancellable(order.status);

    let answer: 'accepted' | 'closed';
    try {
      answer = await this.engine.cancel(orderId, by);
    } catch (error) {
      if (error instanceof CheckoutNotCancellableError) return this.reread(orderId);
      if (error instanceof CheckoutEngineUnavailableError) {
        this.logger.error({ err: error, orderId, by }, 'checkout saga engine did not answer a cancel');
        throw new CheckoutUnavailableException('Cancel is temporarily unavailable; try again', this.retryAfterSec);
      }
      throw error;
    }
    if (answer === 'accepted') this.logger.info({ orderId, by }, 'order cancelled');
    return this.reread(orderId);
  }

  /** After the saga answered, the row is the truth: cancelled is a 200, anything else lost the race. */
  private async reread(orderId: string): Promise<OrderView> {
    const order = await this.orders.findById(orderId);
    if (!order) throw new NotFoundException(`Order not found: ${orderId}`);
    if (order.status !== OrderStatus.CANCELLED) throw notCancellable(order.status);
    return toView(order);
  }
}

// CONFIRMING included: the money is already being taken, and unwinding that is a refund.
function notCancellable(status: OrderStatus): ConflictException {
  return new ConflictException(`Order cannot be cancelled in status ${status}`);
}
