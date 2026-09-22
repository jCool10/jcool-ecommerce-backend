import { Inject, Injectable } from '@nestjs/common';
import { ORDER_PAYMENT_VIEW, type OrderPaymentView } from '@modules/order/application/public/order-payment-view.port';
import type { OrderReadPort, OrderView, StalePendingOrderView } from '../application/ports/order-read.port';

/**
 * Anti-corruption adapter: it may import Order's `application/public` surface (allowed cross-context),
 * never its domain or schema, and it translates Order's vocabulary into Payment's.
 */
@Injectable()
export class OrderReadAdapter implements OrderReadPort {
  constructor(
    @Inject(ORDER_PAYMENT_VIEW)
    private readonly orders: OrderPaymentView,
  ) {}

  async findForPayment(orderId: string): Promise<OrderView | null> {
    const order = await this.orders.findForPayment(orderId);
    if (!order) {
      return null;
    }
    return {
      id: order.id,
      userId: order.userId,
      status: order.status,
      amountMinor: order.totalAmountMinor,
      currency: order.currency,
    };
  }

  async findStalePending(input: { placedBefore: Date; limit: number }): Promise<StalePendingOrderView[]> {
    return this.orders.findStalePending(input);
  }
}
