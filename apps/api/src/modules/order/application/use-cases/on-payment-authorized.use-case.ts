import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { CHECKOUT_SAGA_ENGINE, type CheckoutSagaEnginePort } from '../ports/checkout-saga-engine.port';
import { ORDER_REPOSITORY, type OrderRepositoryPort } from '../ports/order-repository.port';

const LOG_CONTEXT = 'OnPaymentAuthorized';

export interface PaymentAuthorized {
  paymentId: string;
  orderId: string;
  amountMinor: number;
  currency: string;
  authorizedAt: Date;
}

/**
 * Hands the authorization to the saga, which checks the amount and decides. A throw leaves the
 * message unclaimed, so it is redelivered until the saga has it; the saga ignores a repeat.
 */
@Injectable()
export class OnPaymentAuthorizedUseCase {
  constructor(
    @Inject(ORDER_REPOSITORY) private readonly orders: OrderRepositoryPort,
    @Inject(CHECKOUT_SAGA_ENGINE) private readonly engine: CheckoutSagaEnginePort,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(LOG_CONTEXT);
  }

  async execute(event: PaymentAuthorized): Promise<void> {
    const { orderId, paymentId, amountMinor, currency, authorizedAt } = event;
    if (!(await this.orders.findById(orderId))) {
      // Acknowledged: no redelivery conjures the order, and money authorized for nothing is a refund decision.
      this.logger.error({ orderId, paymentId }, 'payment authorized for an order that does not exist');
      return;
    }
    await this.engine.notifyAuthorized(orderId, { paymentId, amountMinor, currency, authorizedAt });
  }
}
