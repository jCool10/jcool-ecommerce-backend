import {
  ConflictException,
  HttpStatus,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { PinoLogger } from 'nestjs-pino';
import { METRICS, type MetricsPort } from '@jcool/metrics-port';
import { getIdempotencyContext, type IdempotencyContext } from '@shared/idempotency';
import { MAX_PENDING_ORDERS_PER_USER } from '../../order.constants';
import type { TryVerdict } from '../../domain/checkout-saga';
import { Order } from '../../domain/order.entity';
import { OrderStatus } from '../../domain/order-status';
import { CheckoutUnavailableException } from '../checkout-unavailable.exception';
import { toView, type OrderView } from '../order-view.mapper';
import { CART_SNAPSHOT_READER, type CartSnapshotReaderPort } from '../ports/cart-snapshot.port';
import { CATALOG_QUERY, type CatalogQueryPort } from '../ports/catalog-query.port';
import {
  CHECKOUT_SAGA_ENGINE,
  CheckoutEngineUnavailableError,
  checkoutStartFor,
  type CheckoutSagaEnginePort,
} from '../ports/checkout-saga-engine.port';
import { IDEMPOTENCY_STORE, type IdempotencyStorePort } from '../ports/idempotency-store.port';
import { ORDER_REPOSITORY, TooManyPendingOrdersError, type OrderRepositoryPort } from '../ports/order-repository.port';
import { CHECKOUT_SAGA_SETTINGS, type CheckoutSagaSettings } from '../saga/checkout-saga.settings';
import { snapshotCart } from '../snapshot-cart';

const LOG_CONTEXT = 'CheckoutOrder';

/**
 * Tx A inserts the RESERVING order; the saga runs the Try and writes its outcome in tx B before the
 * reserve update answers. Every refusal is thrown after tx B has rejected the order and freed its
 * key, so a retry under the same key places a new one. When the engine does not answer, the key is
 * kept: the retry reattaches to the same saga and gets its real answer.
 */
@Injectable()
export class CheckoutOrderUseCase {
  private readonly retryAfterSec: number;

  constructor(
    @Inject(ORDER_REPOSITORY) private readonly orders: OrderRepositoryPort,
    @Inject(CHECKOUT_SAGA_ENGINE) private readonly engine: CheckoutSagaEnginePort,
    @Inject(CART_SNAPSHOT_READER) private readonly cartSnapshotReader: CartSnapshotReaderPort,
    @Inject(CATALOG_QUERY) private readonly catalogQuery: CatalogQueryPort,
    @Inject(IDEMPOTENCY_STORE) private readonly idempotencyStore: IdempotencyStorePort,
    @Inject(CHECKOUT_SAGA_SETTINGS) private readonly settings: CheckoutSagaSettings,
    @Inject(METRICS) private readonly metrics: MetricsPort,
    private readonly cls: ClsService,
    private readonly logger: PinoLogger,
  ) {
    this.retryAfterSec = Math.max(1, Math.ceil(settings.reserveWaitMs / 1000));
    logger.setContext(LOG_CONTEXT);
  }

  async execute(userId: string): Promise<OrderView> {
    const { currency, items } = await snapshotCart(this.cartSnapshotReader, this.catalogQuery, userId);
    const idempotency = getIdempotencyContext(this.cls);
    if (!idempotency) {
      // POST /orders always runs behind the idempotency guard + interceptor, which seed this
      // context over CLS. Its absence is a broken wiring contract: proceeding would persist an
      // order whose IN_PROGRESS key can never be flipped COMPLETED, and a retry would duplicate it.
      throw new InternalServerErrorException('Missing idempotency context for checkout');
    }

    const now = new Date();
    const order = Order.create(userId, currency, items).reserve(
      now,
      new Date(now.getTime() + this.settings.paymentDeadlineMs),
    );
    const { orderId, created } = await this.createReserving(order, idempotency.key);
    if (!created) return this.resume(orderId, idempotency);
    return this.reserve(withId(order, orderId), idempotency);
  }

  private async reserve(order: Order, idempotency: IdempotencyContext): Promise<OrderView> {
    const orderId = order.id as string;
    let verdict: TryVerdict;
    try {
      verdict = await this.engine.reserve(checkoutStartFor(order, this.settings.holdSafetyMs, idempotency));
    } catch (error) {
      if (!(error instanceof CheckoutEngineUnavailableError)) throw error;
      this.logger.error({ err: error, orderId }, 'checkout saga engine did not answer; the order stays reserving');
      throw new CheckoutUnavailableException('Checkout is temporarily unavailable; try again', this.retryAfterSec);
    }

    switch (verdict) {
      case 'HELD':
        this.metrics.recordOrderCreated(OrderStatus.PENDING);
        this.metrics.observeOrderValue(order.totalAmountMinor);
        this.logger.info(
          {
            orderId,
            itemCount: order.items.length,
            totalAmountMinor: order.totalAmountMinor,
            currency: order.currency,
          },
          'order placed',
        );
        return toView(order.confirmPlaced());
      case 'OUT_OF_STOCK':
      case 'CONTENDED':
      case 'CONFLICT':
        this.logger.warn({ orderId, verdict }, 'checkout refused: stock not held');
        throw new ConflictException('Insufficient stock');
      case 'TIMEOUT':
      case 'ERROR':
      case 'ABANDONED':
        this.logger.warn({ orderId, verdict }, 'checkout rejected: the Try gave no answer in time');
        throw new CheckoutUnavailableException('Stock could not be confirmed in time; try again', this.retryAfterSec);
    }
  }

  private async createReserving(order: Order, idempotencyKey: string) {
    try {
      return await this.orders.createReserving(order, idempotencyKey);
    } catch (error) {
      if (error instanceof TooManyPendingOrdersError) {
        this.logger.warn(
          { userId: order.userId, pendingCount: error.pendingCount },
          'checkout refused: too many pending orders',
        );
        throw new ConflictException(
          `Too many pending orders (max ${MAX_PENDING_ORDERS_PER_USER}); pay, cancel, or wait for one to expire before checking out again`,
        );
      }
      throw error;
    }
  }

  /**
   * An earlier attempt under this key committed tx A. A rejected order has already given its key up,
   * so the match is either still reserving, and joins that attempt's saga, or placed and replays.
   */
  private async resume(orderId: string, idempotency: IdempotencyContext): Promise<OrderView> {
    const order = await this.orders.findById(orderId);
    if (!order) throw new NotFoundException(`Order not found: ${orderId}`);
    if (order.status === OrderStatus.RESERVING) {
      this.logger.warn({ orderId }, 'checkout key still reserving an order; rejoining its saga');
      return this.reserve(order, idempotency);
    }
    // Rejected after the key lookup matched it, so the key is free again and the next retry places anew.
    if (order.status === OrderStatus.REJECTED) {
      this.logger.warn({ orderId }, 'checkout key released by a rejection mid-retry');
      throw new CheckoutUnavailableException('Checkout is temporarily unavailable; try again', this.retryAfterSec);
    }
    this.logger.warn({ orderId }, 'checkout key already placed an order; replaying it');
    const view = toView(order);
    await this.idempotencyStore.markCompleted({
      ...idempotency,
      responseStatus: HttpStatus.CREATED,
      responseBody: view,
      orderId,
    });
    return view;
  }
}

// The id only exists once tx A has run; the response is built from the order in hand, not a re-read.
function withId(order: Order, id: string): Order {
  return Order.rehydrate({
    id,
    userId: order.userId,
    status: order.status,
    currency: order.currency,
    items: [...order.items],
    totalAmountMinor: order.totalAmountMinor,
    placedAt: order.placedAt,
    paymentDeadlineAt: order.paymentDeadlineAt,
  });
}
