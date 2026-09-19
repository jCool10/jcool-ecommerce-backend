import { Inject, Injectable } from '@nestjs/common';
import { ORDER_REPOSITORY, type OrderRepositoryPort } from '../ports/order-repository.port';
import type { OrderPaymentSnapshot, OrderPaymentView, StalePendingOrderSnapshot } from './order-payment-view.port';

@Injectable()
export class OrderPaymentViewService implements OrderPaymentView {
  constructor(
    @Inject(ORDER_REPOSITORY)
    private readonly repo: OrderRepositoryPort,
  ) {}

  async findForPayment(orderId: string): Promise<OrderPaymentSnapshot | null> {
    const order = await this.repo.findById(orderId);
    if (!order) {
      return null;
    }
    return {
      id: order.id as string,
      userId: order.userId,
      status: order.status,
      totalAmountMinor: order.totalAmountMinor,
      currency: order.currency,
    };
  }

  async findStalePending(input: { placedBefore: Date; limit: number }): Promise<StalePendingOrderSnapshot[]> {
    return this.repo.findStalePending(input);
  }
}
