import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { OrderStatus } from '../../domain/order-status';
import type { Order } from '../../domain/order.entity';
import { CheckoutUnavailableError } from '../checkout-unavailable.error';
import { CheckoutEngineUnavailableError } from '../ports/checkout-saga-engine.port';
import { ORDER_REFUND_ENGINE, type OrderRefundEnginePort } from '../ports/order-refund-engine.port';
import { ORDER_REPOSITORY, type OrderRepositoryPort } from '../ports/order-repository.port';
import { toView, type OrderView } from '../order-view.mapper';

const LOG_CONTEXT = 'RefundOrder';

/** `settled` false: the refund run is still going (202); the order shows how far it got. */
export interface RefundAnswer {
  order: OrderView;
  settled: boolean;
}

/**
 * The refund run owns the order from PAID on, so this only starts or joins it and reports. Whenever
 * the engine cannot answer, the order row decides: only the run writes REFUNDING, so that status
 * means a run exists.
 */
@Injectable()
export class RefundOrderUseCase {
  constructor(
    @Inject(ORDER_REPOSITORY) private readonly orderRepo: OrderRepositoryPort,
    @Inject(ORDER_REFUND_ENGINE) private readonly engine: OrderRefundEnginePort,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(LOG_CONTEXT);
  }

  async refundAsAdmin(orderId: string, adminId: string): Promise<RefundAnswer> {
    const order = await this.orderRepo.findById(orderId);
    if (!order) {
      throw new NotFoundException(`Order not found: ${orderId}`);
    }
    if (order.status === OrderStatus.REFUNDED) {
      return settled(order);
    }
    if (order.status !== OrderStatus.PAID && order.status !== OrderStatus.REFUNDING) {
      throw notRefundable(order.status);
    }

    this.logger.info({ orderId, adminId }, 'refund requested');
    let result;
    try {
      result = await this.engine.refund(orderId, adminId);
    } catch (error) {
      if (!(error instanceof CheckoutEngineUnavailableError)) throw error;
      this.logger.warn({ orderId, err: error }, 'refund got no answer from the workflow engine');
      const now = await this.reread(orderId);
      if (now.status === OrderStatus.PAID) {
        throw new CheckoutUnavailableError(orderId, 'refund unconfirmed', { cause: error });
      }
      return now.status === OrderStatus.REFUNDED ? settled(now) : running(now);
    }

    if (result.outcome !== 'RUNNING' && result.requestedBy !== adminId) {
      this.logger.info(
        { orderId, adminId, requestedBy: result.requestedBy },
        'refund joined a run another admin started',
      );
    }
    switch (result.outcome) {
      case 'REFUNDED':
        return settled(await this.reread(orderId));
      case 'REFUND_FAILED':
        throw new ConflictException({ code: 'REFUND_FAILED', reason: result.reason });
      case 'NOT_REFUNDABLE':
        throw notRefundable((await this.reread(orderId)).status);
      case 'RUNNING': {
        const now = await this.reread(orderId);
        return now.status === OrderStatus.REFUNDED ? settled(now) : running(now);
      }
    }
  }

  private async reread(orderId: string): Promise<Order> {
    const order = await this.orderRepo.findById(orderId);
    if (!order) {
      throw new Error(`Order ${orderId} vanished during its refund`);
    }
    return order;
  }
}

const settled = (order: Order): RefundAnswer => ({ order: toView(order), settled: true });
const running = (order: Order): RefundAnswer => ({ order: toView(order), settled: false });
const notRefundable = (status: OrderStatus) => new ConflictException(`Order cannot be refunded in status ${status}`);
