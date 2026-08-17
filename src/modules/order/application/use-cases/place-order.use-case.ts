import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { StockReservationError } from '@modules/inventory/application/public/stock-reservation.port';
import { METRICS, type MetricsPort } from '@shared/observability/metrics/metrics.port';
import type { Order } from '../../domain/order.entity';
import { OrderTransitionError } from '../../domain/order-state-machine';
import { ORDER_REPOSITORY, type OrderRepositoryPort } from '../ports/order-repository.port';
import { INVENTORY_RESERVATION, type InventoryReservationPort } from '../ports/inventory-reservation.port';
import { loadOrderView, type OrderView } from '../order-view.mapper';

/**
 * Place an order: DRAFT → PENDING, holding stock atomically. Illegal from any
 * non-DRAFT state → 409. The stock hold runs inside the placement transaction, so a
 * shortfall rolls everything back and the order stays DRAFT (surfaced as 409).
 */
@Injectable()
export class PlaceOrderUseCase {
  constructor(
    @Inject(ORDER_REPOSITORY) private readonly repo: OrderRepositoryPort,
    @Inject(INVENTORY_RESERVATION) private readonly reservation: InventoryReservationPort,
    @Inject(METRICS) private readonly metrics: MetricsPort,
  ) {}

  async execute(userId: string, orderId: string): Promise<OrderView> {
    const order = await this.repo.findForUser(orderId, userId);
    if (!order) {
      throw new NotFoundException(`Order not found: ${orderId}`);
    }

    // Domain guards the transition (pure). DomainError isn't HTTP-mapped, so map to 409 here.
    let placed: Order;
    try {
      placed = order.place(new Date());
    } catch (error) {
      if (error instanceof OrderTransitionError) {
        throw new ConflictException(error.message);
      }
      throw error;
    }

    const lines = placed.items.map((item) => ({ skuId: item.skuId, quantity: item.quantity }));
    let ok: boolean;
    try {
      // Reserve runs inside markPlaced's transaction, so the hold and the status flip
      // commit or roll back together.
      ok = await this.repo.markPlaced(orderId, userId, order.status, placed.placedAt as Date, (tx) =>
        this.reservation.reserve(tx, orderId, lines),
      );
    } catch (error) {
      // Out of stock, or the optimistic retry budget was exhausted: the hold + status
      // flip rolled back together, so the order is still DRAFT. Surface as a conflict.
      if (error instanceof StockReservationError) {
        throw new ConflictException(error.message);
      }
      throw error;
    }
    if (!ok) {
      // Lost a race: someone else moved it out of DRAFT between the read and the update.
      throw new ConflictException('Order is no longer in DRAFT');
    }
    // Count the placement + its value (status is the bounded enum, not an id).
    this.metrics.recordOrderCreated(placed.status);
    this.metrics.observeOrderValue(placed.total().amountMinor);
    return loadOrderView(this.repo, orderId, userId);
  }
}
