import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { CancelBy } from '../../domain/checkout-saga';
import { OrderStatus } from '../../domain/order-status';
import type { Order } from '../../domain/order.entity';
import { CheckoutUnavailableError } from '../checkout-unavailable.error';
import {
  CHECKOUT_SAGA_ENGINE,
  CheckoutCancelRejectedError,
  CheckoutEngineUnavailableError,
  CheckoutSagaClosedError,
  type CheckoutSagaEnginePort,
} from '../ports/checkout-saga-engine.port';
import { ORDER_REPOSITORY, type OrderRepositoryPort } from '../ports/order-repository.port';
import { toView, type OrderView } from '../order-view.mapper';

const LOG_CONTEXT = 'CancelOrder';

/**
 * The saga owns the order once it is placed, so a cancel is a command to it. Its update returns only
 * after stock and payment are compensated, so a 200 means the stock is already back. Whenever the
 * saga cannot answer, the order row decides: a CANCELLED order is a cancel that landed.
 */
@Injectable()
export class CancelOrderUseCase {
  constructor(
    @Inject(ORDER_REPOSITORY) private readonly orderRepo: OrderRepositoryPort,
    @Inject(CHECKOUT_SAGA_ENGINE) private readonly engine: CheckoutSagaEnginePort,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(LOG_CONTEXT);
  }

  async cancelOwn(orderId: string, userId: string): Promise<OrderView> {
    // Someone else's order answers like a missing one, so the route cannot probe which ids exist.
    return this.cancel(await this.orderRepo.findForUser(orderId, userId), orderId, 'buyer');
  }

  async cancelAsAdmin(orderId: string): Promise<OrderView> {
    return this.cancel(await this.orderRepo.findById(orderId), orderId, 'admin');
  }

  private async cancel(order: Order | null, orderId: string, by: CancelBy): Promise<OrderView> {
    if (!order) {
      throw new NotFoundException(`Order not found: ${orderId}`);
    }
    // A repeat is the same request answered again, so a client that lost the first 200 can retry.
    if (order.status === OrderStatus.CANCELLED) {
      return toView(order);
    }
    // PAID included: unwinding that is a refund, which this shop does not do.
    if (order.status !== OrderStatus.PENDING) {
      throw new ConflictException(`Order cannot be cancelled in status ${order.status}`);
    }

    try {
      await this.engine.cancel(orderId, by);
    } catch (error) {
      if (error instanceof CheckoutCancelRejectedError) {
        this.logger.info({ orderId, step: error.step }, 'cancel refused: payment already under way');
        throw new ConflictException('Order cannot be cancelled while its payment is being taken');
      }
      if (error instanceof CheckoutSagaClosedError) {
        return this.settledAs(
          orderId,
          (status) => new ConflictException(`Order cannot be cancelled in status ${status}`),
        );
      }
      if (error instanceof CheckoutEngineUnavailableError) {
        this.logger.warn({ orderId, err: error }, 'cancel got no answer from the checkout saga');
        return this.settledAs(
          orderId,
          () => new CheckoutUnavailableError(orderId, 'cancel unconfirmed', { cause: error }),
        );
      }
      throw error;
    }
    return toView(await this.reread(orderId));
  }

  private async settledAs(orderId: string, otherwise: (status: OrderStatus) => Error): Promise<OrderView> {
    const order = await this.reread(orderId);
    if (order.status !== OrderStatus.CANCELLED) throw otherwise(order.status);
    return toView(order);
  }

  private async reread(orderId: string): Promise<Order> {
    const order = await this.orderRepo.findById(orderId);
    if (!order) {
      throw new Error(`Order ${orderId} vanished during its cancel`);
    }
    return order;
  }
}
