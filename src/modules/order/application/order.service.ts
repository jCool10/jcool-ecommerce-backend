import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Order } from '../domain/order.entity';
import { OrderItem } from '../domain/order-item.entity';
import type { OrderStatus } from '../domain/order-status';
import { OrderTransitionError } from '../domain/order-state-machine';
import { ORDER_REPOSITORY, type OrderRepositoryPort } from './ports/order-repository.port';
import { CART_SNAPSHOT_READER, type CartSnapshotReaderPort } from './ports/cart-snapshot.port';
import { CATALOG_QUERY, type CatalogQueryPort, type OrderSkuView } from './ports/catalog-query.port';
import { INVENTORY_RESERVATION, type InventoryReservationPort } from './ports/inventory-reservation.port';

/** One order line as returned to the client (from the snapshot, not a live price). */
export interface OrderItemView {
  skuId: string;
  productName: string;
  unitPriceMinor: number;
  quantity: number;
  lineTotalMinor: number;
}

export interface OrderView {
  id: string;
  status: OrderStatus;
  currency: string;
  totalAmountMinor: number;
  placedAt: string | null;
  items: OrderItemView[];
}

/**
 * Order write + read orchestration (one service, mirroring CartService). Creating
 * an order SNAPSHOTS the current cart: raw lines come from Cart's published port,
 * price/name are resolved live from Catalog once, then frozen into the order. From
 * then on every read comes from the order's own rows — a later Catalog price change
 * never alters a placed order (the transactional-truth invariant). Cross-context
 * reads go only through the two ports (Cart, Catalog), never their repositories.
 */
@Injectable()
export class OrderService {
  constructor(
    @Inject(ORDER_REPOSITORY)
    private readonly repo: OrderRepositoryPort,
    @Inject(CART_SNAPSHOT_READER)
    private readonly cart: CartSnapshotReaderPort,
    @Inject(CATALOG_QUERY)
    private readonly catalog: CatalogQueryPort,
    @Inject(INVENTORY_RESERVATION)
    private readonly reservation: InventoryReservationPort,
  ) {}

  /** Snapshot the user's cart into a new DRAFT order. Empty/unpurchasable cart → 400. */
  async createFromCart(userId: string): Promise<OrderView> {
    const lines = await this.cart.getLines(userId);
    if (lines.length === 0) {
      throw new BadRequestException('Cart is empty');
    }

    // Resolve each SKU's live price/name once, then freeze it into the order.
    const views = await Promise.all(lines.map((line) => this.catalog.getSkuView(line.skuId)));
    const currency = views.find((v): v is OrderSkuView => v != null)?.currency;
    if (!currency) {
      throw new BadRequestException('Cart items no longer exist in catalog');
    }

    const items = lines.map((line, i) => {
      const v = views[i];
      if (!v) {
        throw new BadRequestException(`SKU no longer exists in catalog: ${line.skuId}`);
      }
      // Order is the sell/commit boundary: an archived product / archived variant is
      // not orderable, even if a residual price lingers. (Availability only — real
      // stock reservation is still BF#1, Week 4.)
      if (!v.isActive) {
        throw new BadRequestException(`SKU is not available for order: ${line.skuId}`);
      }
      if (v.unitPriceMinor == null) {
        throw new BadRequestException(`SKU is not purchasable (no price): ${line.skuId}`);
      }
      if (v.currency !== currency) {
        throw new BadRequestException('Cart mixes currencies; cannot create a single-currency order');
      }
      return OrderItem.of(line.skuId, v.productName, v.unitPriceMinor, line.quantity);
    });

    const orderId = await this.repo.create(Order.create(userId, currency, items));
    return this.buildView(orderId, userId);
  }

  /**
   * Place an order: DRAFT → PENDING. Illegal from any non-DRAFT state → 409. Runs
   * the status change atomically in a transaction (the seam later weeks extend).
   */
  async place(userId: string, orderId: string): Promise<OrderView> {
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

    // EXTENSION BF#1 (T4): reserve stock. No-op in Week 3; Week 4 supplies a real
    // adapter and this moves into the placement transaction (shared unit of work).
    await this.reservation.reserve(
      orderId,
      placed.items.map((item) => ({ skuId: item.skuId, quantity: item.quantity })),
    );

    const ok = await this.repo.markPlaced(orderId, userId, order.status, placed.placedAt as Date);
    // EXTENSION BF#4 (T8-9): append `placed.toPlacedEvent()` to the outbox in the same transaction here.
    if (!ok) {
      // Lost a race: someone else moved it out of DRAFT between the read and the update.
      throw new ConflictException('Order is no longer in DRAFT');
    }
    return this.buildView(orderId, userId);
  }

  async getOne(userId: string, orderId: string): Promise<OrderView> {
    const order = await this.repo.findForUser(orderId, userId);
    if (!order) {
      throw new NotFoundException(`Order not found: ${orderId}`);
    }
    return toView(order);
  }

  async list(userId: string): Promise<OrderView[]> {
    const orders = await this.repo.findAllForUser(userId);
    return orders.map(toView);
  }

  // Re-read after a mutation so the client always sees persisted state.
  private async buildView(orderId: string, userId: string): Promise<OrderView> {
    const order = await this.repo.findForUser(orderId, userId);
    if (!order) {
      throw new NotFoundException(`Order not found: ${orderId}`);
    }
    return toView(order);
  }
}

// Map the domain aggregate to the read model. Totals come from the snapshot lines,
// so they are stable against later Catalog price changes.
function toView(order: Order): OrderView {
  return {
    id: order.id as string,
    status: order.status,
    currency: order.currency,
    totalAmountMinor: order.total().amountMinor,
    placedAt: order.placedAt ? order.placedAt.toISOString() : null,
    items: order.items.map((item) => ({
      skuId: item.skuId,
      productName: item.productName,
      unitPriceMinor: item.unitPriceMinor,
      quantity: item.quantity,
      lineTotalMinor: item.lineTotal(order.currency).amountMinor,
    })),
  };
}
