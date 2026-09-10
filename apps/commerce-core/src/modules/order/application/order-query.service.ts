import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  ORDER_REPOSITORY,
  type AdminOrderPageQuery,
  type OrderPage,
  type OrderPageQuery,
  type OrderRepositoryPort,
} from './ports/order-repository.port';
import { loadOrderView, toView, type OrderView } from './order-view.mapper';

export interface OrderPageView {
  items: OrderView[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/**
 * Buyer reads are user-scoped at the repository, so someone else's id is indistinguishable from one
 * that does not exist. The admin reads drop that scope and rely on the admin controller's role guard.
 */
@Injectable()
export class OrderQueryService {
  constructor(
    @Inject(ORDER_REPOSITORY)
    private readonly repo: OrderRepositoryPort,
  ) {}

  getOne(userId: string, orderId: string): Promise<OrderView> {
    return loadOrderView(this.repo, orderId, userId);
  }

  async list(userId: string, query: OrderPageQuery): Promise<OrderPageView> {
    return toPageView(await this.repo.findPageForUser(userId, query), query);
  }

  async adminList(query: AdminOrderPageQuery): Promise<OrderPageView> {
    return toPageView(await this.repo.findPage(query), query);
  }

  async adminGetOne(orderId: string): Promise<OrderView> {
    const order = await this.repo.findById(orderId);
    if (!order) {
      throw new NotFoundException(`Order not found: ${orderId}`);
    }
    return toView(order);
  }
}

function toPageView({ items, total }: OrderPage, { page, pageSize }: OrderPageQuery): OrderPageView {
  return {
    items: items.map(toView),
    total,
    page,
    pageSize,
    totalPages: pageSize > 0 ? Math.ceil(total / pageSize) : 0,
  };
}
