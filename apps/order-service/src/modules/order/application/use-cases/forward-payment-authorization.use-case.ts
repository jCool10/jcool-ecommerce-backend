import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { PaymentAuthorization } from '../../domain/checkout-saga';
import { toCheckoutSagaStart } from '../checkout-saga-start';
import { CHECKOUT_SAGA_ENGINE, type CheckoutSagaEnginePort } from '../ports/checkout-saga-engine.port';
import { ORDER_REPOSITORY, type OrderRepositoryPort } from '../ports/order-repository.port';

const LOG_CONTEXT = 'ForwardPaymentAuthorization';

/**
 * Only forwards: the event can be forged, so the saga verifies it with payment before committing
 * anything. The start is used only when the run has closed, and that late run can only void.
 */
@Injectable()
export class ForwardPaymentAuthorizationUseCase {
  constructor(
    @Inject(ORDER_REPOSITORY) private readonly orderRepo: OrderRepositoryPort,
    @Inject(CHECKOUT_SAGA_ENGINE) private readonly engine: CheckoutSagaEnginePort,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(LOG_CONTEXT);
  }

  async execute(orderId: string, authorization: PaymentAuthorization): Promise<void> {
    const order = await this.orderRepo.findById(orderId);
    if (!order) {
      this.logger.warn({ orderId, paymentId: authorization.paymentId }, 'authorization for an unknown order, dropped');
      return;
    }
    if (!order.paymentDeadlineAt) {
      // Payment only opens sessions the saga asked for, so this is a bug, and a hold nobody will void.
      this.logger.error(
        { orderId, paymentId: authorization.paymentId, status: order.status },
        'authorization for an order without a payment deadline, dropped',
      );
      return;
    }
    await this.engine.notifyAuthorized(toCheckoutSagaStart(order, 'lateAuthorization'), authorization);
  }
}
