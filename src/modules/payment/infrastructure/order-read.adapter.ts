import { Inject, Injectable } from '@nestjs/common';
import { ORDER_PAYMENT_VIEW, type OrderPaymentView } from '@modules/order/application/public/order-payment-view.port';
import type { OrderReadPort, OrderView } from '../application/ports/order-read.port';

/**
 * Anti-corruption adapter: implements Payment's `OrderReadPort` by delegating to Order's published
 * `ORDER_PAYMENT_VIEW`. Imports only Order's `application/public` surface (allowed cross-context) —
 * never its domain/schema. Maps Order's `totalAmountMinor` to Payment's `amountMinor` vocabulary.
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
}
