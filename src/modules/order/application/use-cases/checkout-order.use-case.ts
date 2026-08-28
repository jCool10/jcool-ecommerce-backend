import {
  BadRequestException,
  ConflictException,
  HttpStatus,
  Inject,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { StockReservationError } from '@modules/inventory/application/public/stock-reservation.port';
import { METRICS, type MetricsPort } from '@shared/observability/metrics/metrics.port';
import { OUTBOX_WRITER, type OutboxWriterPort } from '@shared/messaging/outbox/outbox-writer.port';
import { getIdempotencyContext } from '@shared/idempotency';
import { Order } from '../../domain/order.entity';
import { OrderItem } from '../../domain/order-item.entity';
import { ORDER_REPOSITORY, type OrderRepositoryPort } from '../ports/order-repository.port';
import { CART_SNAPSHOT_READER, type CartSnapshotReaderPort } from '../ports/cart-snapshot.port';
import { CATALOG_QUERY, type CatalogQueryPort, type OrderSkuView } from '../ports/catalog-query.port';
import { INVENTORY_RESERVATION, type InventoryReservationPort } from '../ports/inventory-reservation.port';
import { IDEMPOTENCY_STORE, type IdempotencyStorePort } from '../ports/idempotency-store.port';
import { loadOrderView, toView, type OrderView } from '../order-view.mapper';
import { toPlacedOutboxRecord } from '../order-outbox.mapper';

/**
 * Atomic checkout: snapshot the user's cart into an order and, in ONE transaction, persist it at
 * PENDING, hold stock, append the OrderPlaced event to the outbox, and freeze the idempotency
 * result. The price/name of each line is resolved live from Catalog once, then frozen — a later
 * Catalog price change never moves a placed order's total (transactional truth). Order +
 * reservation + event + idempotency COMPLETED commit together: a stock shortfall rolls the whole
 * thing back (no order, no event, no key), so the client can safely retry.
 *
 * The `{scope, key}` for the idempotency flip rides down over CLS, set by the interceptor on the
 * wired route — no controller plumbing. Cross-context reads go only through the two ports.
 */
@Injectable()
export class CheckoutOrderUseCase {
  constructor(
    @Inject(ORDER_REPOSITORY) private readonly repo: OrderRepositoryPort,
    @Inject(CART_SNAPSHOT_READER) private readonly cart: CartSnapshotReaderPort,
    @Inject(CATALOG_QUERY) private readonly catalog: CatalogQueryPort,
    @Inject(INVENTORY_RESERVATION) private readonly reservation: InventoryReservationPort,
    @Inject(IDEMPOTENCY_STORE) private readonly idempotency: IdempotencyStorePort,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriterPort,
    @Inject(METRICS) private readonly metrics: MetricsPort,
    private readonly cls: ClsService,
  ) {}

  /** Empty/unpurchasable cart → 400; stock shortfall → 409. */
  async execute(userId: string): Promise<OrderView> {
    const { currency, items } = await this.snapshotCart(userId);
    const placed = Order.create(userId, currency, items).place(new Date());
    const lines = items.map((item) => ({ skuId: item.skuId, quantity: item.quantity }));
    const idem = getIdempotencyContext(this.cls);
    if (!idem) {
      // POST /orders always runs behind the idempotency guard + interceptor, which seed this
      // context over CLS. Its absence is a broken wiring contract: proceeding would persist an
      // order whose IN_PROGRESS key can never be flipped COMPLETED, and a retry would duplicate it.
      throw new InternalServerErrorException('Missing idempotency context for checkout');
    }

    let result;
    try {
      result = await this.repo.createCheckout(
        placed,
        idem.key,
        (tx, orderId) => this.reservation.reserve(tx, orderId, lines),
        (tx, orderId) => this.outbox.append(tx, toPlacedOutboxRecord(this.withId(placed, orderId).toPlacedEvent())),
        (tx, orderId) =>
          this.idempotency.markCompleted(
            {
              scope: idem.scope,
              key: idem.key,
              responseStatus: HttpStatus.CREATED,
              responseBody: this.viewOf(placed, orderId),
              orderId,
            },
            tx,
          ),
      );
    } catch (error) {
      // The step is the whole unit, not just the stock call: the hold, the order, the event and the
      // key COMPLETED commit together, so any fault in there ends with no hold taken.
      this.metrics.recordSagaStep('reserve', 'failed');
      // Out of stock, or the optimistic retry budget was exhausted under contention — the one fault
      // here that is an answer to the caller rather than a fault of ours. Surface as 409.
      if (error instanceof StockReservationError) {
        throw new ConflictException(error.message);
      }
      throw error;
    }

    if (result.created) {
      // Only a fresh hold is a step: the replay below reuses one an earlier attempt already took.
      this.metrics.recordSagaStep('reserve', 'success');
      this.metrics.recordOrderCreated(placed.status);
      this.metrics.observeOrderValue(placed.totalAmountMinor);
      return this.viewOf(placed, result.orderId);
    }

    // Crash-reclaim heal: an order already carried this key (a prior attempt committed, then its
    // idempotency row was reclaimed). Point the key at the existing order and replay it — no second
    // order, no second hold.
    const view = await loadOrderView(this.repo, result.orderId, userId);
    await this.idempotency.markCompleted({
      scope: idem.scope,
      key: idem.key,
      responseStatus: HttpStatus.CREATED,
      responseBody: view,
      orderId: result.orderId,
    });
    return view;
  }

  private async snapshotCart(userId: string): Promise<{ currency: string; items: OrderItem[] }> {
    const lines = await this.cart.getLines(userId);
    if (lines.length === 0) {
      throw new BadRequestException('Cart is empty');
    }

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
      // Order is the sell/commit boundary: an archived product / archived variant is not orderable,
      // even if a residual price lingers.
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
    return { currency, items };
  }

  // The id only exists after the INSERT, so the cached response and the outbox event are both built
  // from the in-memory order plus its freshly-assigned id — no DB re-read on the checkout path.
  private withId(order: Order, id: string): Order {
    return Order.rehydrate({
      id,
      userId: order.userId,
      status: order.status,
      currency: order.currency,
      items: [...order.items],
      totalAmountMinor: order.totalAmountMinor,
      placedAt: order.placedAt,
    });
  }

  // The response cached for replay; byte-identical to `OrderResponseDto.fromView` (a passthrough).
  private viewOf(order: Order, id: string): OrderView {
    return toView(this.withId(order, id));
  }
}
