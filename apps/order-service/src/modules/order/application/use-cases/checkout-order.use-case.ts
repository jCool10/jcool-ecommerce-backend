import {
  BadRequestException,
  ConflictException,
  HttpStatus,
  Inject,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClsService } from 'nestjs-cls';
import { PinoLogger } from 'nestjs-pino';
import { METRICS, type MetricsPort } from '@jcool/metrics-port';
import type { CheckoutSagaConfig } from '../../../../config/checkout-saga.config';
import { getIdempotencyContext, type IdempotencyContext } from '../../../../shared/idempotency';
import { MAX_PENDING_ORDERS_PER_USER } from '../../order.constants';
import type { ReserveOutcome } from '../../domain/checkout-saga';
import { Order } from '../../domain/order.entity';
import { OrderItem } from '../../domain/order-item.entity';
import { OrderStatus } from '../../domain/order-status';
import { toCheckoutSagaStart } from '../checkout-saga-start';
import { CheckoutUnavailableError } from '../checkout-unavailable.error';
import { CART_SNAPSHOT_READER, type CartSnapshotReaderPort } from '../ports/cart-snapshot.port';
import { CATALOG_QUERY, type CatalogQueryPort, type OrderSkuView } from '../ports/catalog-query.port';
import {
  CHECKOUT_SAGA_ENGINE,
  CheckoutEngineUnavailableError,
  CheckoutSagaClosedError,
  type CheckoutSagaEnginePort,
} from '../ports/checkout-saga-engine.port';
import { IDEMPOTENCY_STORE, type IdempotencyStorePort } from '../ports/idempotency-store.port';
import { ORDER_REPOSITORY, TooManyPendingOrdersError, type OrderRepositoryPort } from '../ports/order-repository.port';
import { toView, type OrderView } from '../order-view.mapper';

const LOG_CONTEXT = 'CheckoutOrder';

const REFUSED: ReadonlySet<ReserveOutcome> = new Set(['OUT_OF_STOCK', 'CONTENDED', 'CONFLICT']);

/**
 * Writes the order RESERVING (tx A), then lets the saga's Try decide it. A held order is answered as
 * PENDING; the saga's own transaction already froze the idempotency key with the same body. Anything
 * without a definite answer is a 503 the client retries under the same key, which lands on the same
 * order and the same Try. Each line's price is frozen at snapshot time.
 */
@Injectable()
export class CheckoutOrderUseCase {
  private readonly paymentDeadlineMs: number;

  constructor(
    @Inject(ORDER_REPOSITORY) private readonly orderRepo: OrderRepositoryPort,
    @Inject(CART_SNAPSHOT_READER) private readonly cartSnapshotReader: CartSnapshotReaderPort,
    @Inject(CATALOG_QUERY) private readonly catalogQuery: CatalogQueryPort,
    @Inject(CHECKOUT_SAGA_ENGINE) private readonly engine: CheckoutSagaEnginePort,
    @Inject(IDEMPOTENCY_STORE) private readonly idempotencyStore: IdempotencyStorePort,
    @Inject(METRICS) private readonly metrics: MetricsPort,
    config: ConfigService,
    private readonly cls: ClsService,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(LOG_CONTEXT);
    this.paymentDeadlineMs = config.getOrThrow<CheckoutSagaConfig>('checkoutSaga').paymentDeadlineSec * 1000;
  }

  async execute(userId: string): Promise<OrderView> {
    const { currency, items } = await this.snapshotCart(userId);
    const idempotency = getIdempotencyContext(this.cls);
    if (!idempotency) {
      // POST /orders always runs behind the idempotency guard + interceptor. Without the key a retry
      // could not find this order again and would place a second one.
      throw new InternalServerErrorException('Missing idempotency context for checkout');
    }

    const now = new Date();
    const draft = Order.create(userId, currency, items).reserve(now, new Date(now.getTime() + this.paymentDeadlineMs));
    const { created, order } = await this.createReserving(draft, idempotency.key);

    if (order.status === OrderStatus.REJECTED) {
      throw new CheckoutUnavailableError(order.id as string, 'order already rejected');
    }
    if (order.status !== OrderStatus.RESERVING) {
      // An earlier attempt under this key got past the Try (its 503 was lost, or its row reclaimed).
      return this.replay(order, idempotency);
    }

    const outcome = await this.reserve(order);
    if (outcome === null) {
      return this.replayAfterClose(order.id as string, idempotency);
    }
    if (outcome !== 'HELD') {
      if (REFUSED.has(outcome)) {
        this.logger.warn({ orderId: order.id, outcome }, 'checkout refused: insufficient stock');
        throw new ConflictException('Insufficient stock');
      }
      this.logger.warn({ orderId: order.id, outcome }, 'checkout try ended without an answer');
      throw new CheckoutUnavailableError(order.id as string, `try ${outcome}`);
    }

    const view = toView(order.confirmPlaced());
    if (!created) {
      // tx B froze the key only if it still held the row this request now holds; freeze it again.
      await this.markCompleted(view, idempotency);
      return view;
    }
    this.metrics.recordOrderCreated(view.status);
    this.metrics.observeOrderValue(view.totalAmountMinor);
    this.logger.info(
      { orderId: view.id, itemCount: items.length, totalAmountMinor: view.totalAmountMinor, currency },
      'order placed',
    );
    return view;
  }

  private async createReserving(draft: Order, idempotencyKey: string) {
    try {
      return await this.orderRepo.createReserving({ order: draft, idempotencyKey });
    } catch (error) {
      if (error instanceof TooManyPendingOrdersError) {
        this.logger.warn(
          { userId: draft.userId, pendingCount: error.pendingCount },
          'checkout refused: too many pending orders',
        );
        throw new ConflictException(
          `Too many pending orders (max ${MAX_PENDING_ORDERS_PER_USER}); pay, cancel, or wait for one to expire before checking out again`,
        );
      }
      throw error;
    }
  }

  /** null: the run has already closed, so only the order row can tell what happened. */
  private async reserve(order: Order): Promise<ReserveOutcome | null> {
    try {
      return await this.engine.reserve(toCheckoutSagaStart(order, 'checkout'));
    } catch (error) {
      if (error instanceof CheckoutSagaClosedError) return null;
      if (error instanceof CheckoutEngineUnavailableError) {
        this.logger.warn({ orderId: order.id, err: error }, 'checkout saga engine unavailable');
        throw new CheckoutUnavailableError(order.id as string, 'engine unavailable', { cause: error });
      }
      throw error;
    }
  }

  private async replayAfterClose(orderId: string, idempotency: IdempotencyContext): Promise<OrderView> {
    const order = await this.orderRepo.findById(orderId);
    if (!order) {
      throw new Error(`Order ${orderId} vanished while its checkout saga was closing`);
    }
    if (order.status === OrderStatus.RESERVING || order.status === OrderStatus.REJECTED) {
      throw new CheckoutUnavailableError(orderId, `saga closed with the order ${order.status}`);
    }
    return this.replay(order, idempotency);
  }

  private async replay(order: Order, idempotency: IdempotencyContext): Promise<OrderView> {
    this.logger.warn({ orderId: order.id, status: order.status }, 'checkout key already placed an order, replaying it');
    const view = toView(order);
    await this.markCompleted(view, idempotency);
    return view;
  }

  private markCompleted(view: OrderView, { scope, key }: IdempotencyContext): Promise<void> {
    return this.idempotencyStore.markCompleted({
      scope,
      key,
      responseStatus: HttpStatus.CREATED,
      responseBody: view,
      orderId: view.id,
    });
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
}
