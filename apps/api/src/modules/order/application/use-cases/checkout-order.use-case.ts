import {
  BadRequestException,
  ConflictException,
  HttpStatus,
  Inject,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { PinoLogger } from 'nestjs-pino';
import { StockReservationError } from '@modules/product/application/public/product-stock-reservation.port';
import { METRICS, type MetricsPort } from '@jcool/metrics-port';
import { OUTBOX_WRITER, type OutboxWriterPort } from '@shared/messaging/outbox/outbox-writer.port';
import { getIdempotencyContext } from '@shared/idempotency';
import { MAX_PENDING_ORDERS_PER_USER } from '../../order.constants';
import { Order } from '../../domain/order.entity';
import { OrderItem } from '../../domain/order-item.entity';
import { ORDER_REPOSITORY, TooManyPendingOrdersError, type OrderRepositoryPort } from '../ports/order-repository.port';
import { CART_SNAPSHOT_READER, type CartSnapshotReaderPort } from '../ports/cart-snapshot.port';
import { CATALOG_QUERY, type CatalogQueryPort, type OrderSkuView } from '../ports/catalog-query.port';
import { INVENTORY_RESERVATION, type InventoryReservationPort } from '../ports/inventory-reservation.port';
import { IDEMPOTENCY_STORE, type IdempotencyStorePort } from '../ports/idempotency-store.port';
import { loadOrderView, toView, type OrderView } from '../order-view.mapper';
import { toPlacedOutboxRecord } from '../order-outbox.mapper';

const LOG_CONTEXT = 'CheckoutOrder';

/**
 * Order + reservation + outbox event + idempotency COMPLETED commit in ONE transaction: a stock
 * shortfall, or the user's own pending-order cap, rolls all of it back (no order, no event, no key),
 * so the client can safely retry. Each line's price is frozen at snapshot time, so a later Catalog
 * price change never moves the total.
 */
@Injectable()
export class CheckoutOrderUseCase {
  constructor(
    @Inject(ORDER_REPOSITORY) private readonly orderRepo: OrderRepositoryPort,
    @Inject(CART_SNAPSHOT_READER) private readonly cartSnapshotReader: CartSnapshotReaderPort,
    @Inject(CATALOG_QUERY) private readonly catalogQuery: CatalogQueryPort,
    @Inject(INVENTORY_RESERVATION) private readonly inventoryReservation: InventoryReservationPort,
    @Inject(IDEMPOTENCY_STORE) private readonly idempotencyStore: IdempotencyStorePort,
    @Inject(OUTBOX_WRITER) private readonly outboxWriter: OutboxWriterPort,
    @Inject(METRICS) private readonly metrics: MetricsPort,
    private readonly cls: ClsService,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(LOG_CONTEXT);
  }

  async execute(userId: string): Promise<OrderView> {
    const { currency, items } = await this.snapshotCart(userId);
    const placed = Order.create(userId, currency, items).place(new Date());
    const lines = items.map((item) => ({ skuId: item.skuId, quantity: item.quantity }));
    const idempotencyContext = getIdempotencyContext(this.cls);
    if (!idempotencyContext) {
      // POST /orders always runs behind the idempotency guard + interceptor, which seed this
      // context over CLS. Its absence is a broken wiring contract: proceeding would persist an
      // order whose IN_PROGRESS key can never be flipped COMPLETED, and a retry would duplicate it.
      throw new InternalServerErrorException('Missing idempotency context for checkout');
    }

    let checkout;
    try {
      checkout = await this.orderRepo.createCheckout(
        placed,
        idempotencyContext.key,
        (tx, orderId) => this.inventoryReservation.reserve(tx, orderId, lines),
        (tx, orderId) =>
          this.outboxWriter.append(tx, toPlacedOutboxRecord(this.withId(placed, orderId).toPlacedEvent())),
        (tx, orderId) =>
          this.idempotencyStore.markCompleted(
            {
              scope: idempotencyContext.scope,
              key: idempotencyContext.key,
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
      // Answers to the caller rather than faults of ours, so 409. The stock error's own message
      // carries the available count, so it goes to the log only.
      if (error instanceof TooManyPendingOrdersError) {
        this.logger.warn({ userId, pendingCount: error.pendingCount }, 'checkout refused: too many pending orders');
        throw new ConflictException(
          `Too many pending orders (max ${MAX_PENDING_ORDERS_PER_USER}); pay, cancel, or wait for one to expire before checking out again`,
        );
      }
      if (error instanceof StockReservationError) {
        this.logger.warn({ err: error }, 'checkout refused: insufficient stock');
        throw new ConflictException('Insufficient stock');
      }
      throw error;
    }

    if (checkout.created) {
      // Only a fresh hold is a step: the replay below reuses one an earlier attempt already took.
      this.metrics.recordSagaStep('reserve', 'success');
      this.metrics.recordOrderCreated(placed.status);
      this.metrics.observeOrderValue(placed.totalAmountMinor);
      this.logger.info(
        {
          orderId: checkout.orderId,
          itemCount: items.length,
          totalAmountMinor: placed.totalAmountMinor,
          currency,
        },
        'order placed',
      );
      return this.viewOf(placed, checkout.orderId);
    }

    // Crash-reclaim heal: an order already carried this key (a prior attempt committed, then its
    // idempotency row was reclaimed). Point the key at the existing order and replay it — no second
    // order, no second hold.
    this.logger.warn({ orderId: checkout.orderId }, 'checkout key already placed an order — replaying it');
    const view = await loadOrderView(this.orderRepo, checkout.orderId, userId);
    await this.idempotencyStore.markCompleted({
      scope: idempotencyContext.scope,
      key: idempotencyContext.key,
      responseStatus: HttpStatus.CREATED,
      responseBody: view,
      orderId: checkout.orderId,
    });
    return view;
  }

  private async snapshotCart(userId: string): Promise<{ currency: string; items: OrderItem[] }> {
    const lines = await this.cartSnapshotReader.getLines(userId);
    if (lines.length === 0) {
      throw new BadRequestException('Cart is empty');
    }

    const views = await this.catalogQuery.getSkuViews(lines.map((line) => line.skuId));
    const viewBySku = new Map<string, OrderSkuView>(views.map((view) => [view.skuId, view]));
    // The order's currency is the first surviving line's, walked in cart order rather than in the
    // batch read's order, which would anchor on a different line and blame a different one below.
    const currency = lines.map((line) => viewBySku.get(line.skuId)).find((v) => v != null)?.currency;
    if (!currency) {
      throw new BadRequestException('Cart items no longer exist in catalog');
    }

    const items = lines.map((line) => {
      const skuView = viewBySku.get(line.skuId);
      if (!skuView) {
        throw new BadRequestException(`SKU no longer exists in catalog: ${line.skuId}`);
      }
      // Order is the sell/commit boundary: an archived product / archived variant is not orderable,
      // even if a residual price lingers.
      if (!skuView.isActive) {
        throw new BadRequestException(`SKU is not available for order: ${line.skuId}`);
      }
      if (skuView.unitPriceMinor == null) {
        throw new BadRequestException(`SKU is not purchasable (no price): ${line.skuId}`);
      }
      if (skuView.currency !== currency) {
        throw new BadRequestException('Cart mixes currencies; cannot create a single-currency order');
      }
      return OrderItem.of(line.skuId, skuView.productName, skuView.unitPriceMinor, line.quantity);
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
