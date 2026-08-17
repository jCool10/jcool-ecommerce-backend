import { Inject, Injectable } from '@nestjs/common';
import { ORDER_REPOSITORY, type OrderRepositoryPort } from './ports/order-repository.port';
import { loadOrderView, toView, type OrderView } from './order-view.mapper';

/** Read side for a user's orders: point read (404 if absent) and list. */
@Injectable()
export class OrderQueryService {
  constructor(
    @Inject(ORDER_REPOSITORY)
    private readonly repo: OrderRepositoryPort,
  ) {}

  getOne(userId: string, orderId: string): Promise<OrderView> {
    return loadOrderView(this.repo, orderId, userId);
  }

  async list(userId: string): Promise<OrderView[]> {
    const orders = await this.repo.findAllForUser(userId);
    return orders.map(toView);
  }
}
