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
import { toError } from '@jcool/kernel';
import { METRICS, type MetricsPort } from '@jcool/metrics-port';
import { getIdempotencyContext, type IdempotencyContext } from '@shared/idempotency';
import { MAX_PENDING_ORDERS_PER_USER } from '../../order.constants';
import { onTryResult, type TryVerdict } from '../../domain/checkout-saga';
import { Order } from '../../domain/order.entity';
import { OrderStatus } from '../../domain/order-status';
import { CheckoutUnavailableException } from '../checkout-unavailable.exception';
import { toView, type OrderView } from '../order-view.mapper';
import { CART_SNAPSHOT_READER, type CartSnapshotReaderPort } from '../ports/cart-snapshot.port';
import { CATALOG_QUERY, type CatalogQueryPort } from '../ports/catalog-query.port';
import {
  CHECKOUT_SAGA_REPOSITORY,
  type CheckoutSaga,
  type CheckoutSagaRepositoryPort,
} from '../ports/checkout-saga-repository.port';
import { IDEMPOTENCY_STORE, type IdempotencyStorePort } from '../ports/idempotency-store.port';
import { INVENTORY_TCC, type InventoryTccPort, type ReserveLine } from '../ports/inventory-participant.port';
import {
  ORDER_REPOSITORY,
  TooManyPendingOrdersError,
  type CreateReservingResult,
  type OrderRepositoryPort,
} from '../ports/order-repository.port';
import { CHECKOUT_SAGA_SETTINGS, type CheckoutSagaSettings } from '../saga/checkout-saga.settings';
import { CheckoutSagaWriter } from '../saga/checkout-saga.writer';
import { snapshotCart } from '../snapshot-cart';
import { AdvanceCheckoutSagaUseCase } from './advance-checkout-saga.use-case';

const LOG_CONTEXT = 'CheckoutOrder';
// Caps only how long the buyer's 503 waits; the release itself runs on under its own lease.
const INLINE_RELEASE_WAIT_MS = 1_000;

/**
 * Two short transactions around a Try that runs outside both. Tx A inserts the RESERVING order with
 * its saga already leased to this request; tx B is that lease's apply, so a runner that healed the
 * saga in between makes tx B lose rather than overwrite the heal. Every refusal is thrown only after
 * tx B has rejected the order and freed its key, so a retry under the same key places a new one.
 */
@Injectable()
export class CheckoutOrderUseCase {
  private readonly retryAfterSec: number;

  constructor(
    @Inject(ORDER_REPOSITORY) private readonly orders: OrderRepositoryPort,
    @Inject(CHECKOUT_SAGA_REPOSITORY) private readonly sagas: CheckoutSagaRepositoryPort,
    private readonly writer: CheckoutSagaWriter,
    private readonly advance: AdvanceCheckoutSagaUseCase,
    @Inject(CART_SNAPSHOT_READER) private readonly cartSnapshotReader: CartSnapshotReaderPort,
    @Inject(CATALOG_QUERY) private readonly catalogQuery: CatalogQueryPort,
    @Inject(INVENTORY_TCC) private readonly inventory: InventoryTccPort,
    @Inject(IDEMPOTENCY_STORE) private readonly idempotencyStore: IdempotencyStorePort,
    @Inject(CHECKOUT_SAGA_SETTINGS) private readonly settings: CheckoutSagaSettings,
    @Inject(METRICS) private readonly metrics: MetricsPort,
    private readonly cls: ClsService,
    private readonly logger: PinoLogger,
  ) {
    // An in-flight request settles its order within one Try budget, so a retry after that sees it placed.
    this.retryAfterSec = Math.max(1, Math.ceil(settings.tryTimeoutMs / 1000));
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
    const order = Order.create(userId, currency, items).reserve(now);
    const deadlineAt = new Date(now.getTime() + this.settings.paymentDeadlineMs);
    const reserving = await this.createReserving(order, idempotency.key, deadlineAt);
    if (!reserving.created) return this.replay(reserving.orderId, idempotency);

    const { orderId, saga: lease } = reserving;
    const verdict = await this.tryReserve({
      orderId,
      lines: items.map((item) => ({ skuId: item.skuId, quantity: item.quantity })),
      holdUntil: new Date(deadlineAt.getTime() + this.settings.holdSafetyMs),
    });
    this.metrics.recordSagaStep('try_reserve', verdict === 'HELD' ? 'success' : 'failed');

    const view = toView(withId(order, orderId).confirmPlaced());
    const applied = await this.writer.applyLeased(lease, onTryResult(verdict), {
      inTx:
        verdict === 'HELD'
          ? (tx) => this.idempotencyStore.markCompleted(completion(idempotency, orderId, view), tx)
          : undefined,
    });
    if (!applied) {
      this.logger.warn({ orderId, verdict }, 'checkout lost its saga to the runner before placing the order');
      throw new CheckoutUnavailableException('Checkout could not be completed in time; try again', this.retryAfterSec);
    }

    switch (verdict) {
      case 'HELD':
        this.metrics.recordOrderCreated(OrderStatus.PENDING);
        this.metrics.observeOrderValue(order.totalAmountMinor);
        this.logger.info(
          { orderId, itemCount: items.length, totalAmountMinor: order.totalAmountMinor, currency },
          'order placed',
        );
        return view;
      case 'TIMEOUT':
      case 'ERROR':
        await this.releaseInline(orderId);
        throw new CheckoutUnavailableException('Stock could not be confirmed in time; try again', this.retryAfterSec);
      default:
        this.logger.warn({ orderId, verdict }, 'checkout refused: stock not held');
        throw new ConflictException('Insufficient stock');
    }
  }

  private async createReserving(
    order: Order,
    idempotencyKey: string,
    deadlineAt: Date,
  ): Promise<CreateReservingResult<CheckoutSaga>> {
    try {
      return await this.orders.createReserving(order, idempotencyKey, (tx, orderId) =>
        this.sagas.insertLeased(tx, { orderId, deadlineAt, leaseMs: this.settings.leaseMs }),
      );
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

  /** A Try that outlives the timeout runs on; the release's fence is what makes its late hold harmless. */
  private async tryReserve(input: { orderId: string; lines: ReserveLine[]; holdUntil: Date }): Promise<TryVerdict> {
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<'TIMEOUT'>((resolve) => {
      timer = setTimeout(() => resolve('TIMEOUT'), this.settings.tryTimeoutMs);
    });
    try {
      return await Promise.race([this.inventory.tryReserve(input), timedOut]);
    } catch (error) {
      this.logger.warn({ err: toError(error), orderId: input.orderId }, 'Try failed without an answer');
      return 'ERROR';
    } finally {
      clearTimeout(timer);
    }
  }

  private async releaseInline(orderId: string): Promise<void> {
    const release = this.advance.execute(orderId).catch((error: unknown) => {
      this.logger.error({ err: toError(error), orderId }, 'inline release failed; the runner takes it over');
    });
    await Promise.race([release, sleep(INLINE_RELEASE_WAIT_MS)]);
  }

  /**
   * Crash-reclaim heal: an earlier attempt under this key committed tx A, then its idempotency row
   * was reclaimed. A rejected order has already given its key up, so the match is either still in
   * flight or placed.
   */
  private async replay(orderId: string, idempotency: IdempotencyContext): Promise<OrderView> {
    const order = await this.orders.findById(orderId);
    if (!order) throw new NotFoundException(`Order not found: ${orderId}`);
    if (order.status === OrderStatus.RESERVING) {
      throw new CheckoutUnavailableException('Checkout is still in progress; try again', this.retryAfterSec);
    }
    this.logger.warn({ orderId }, 'checkout key already placed an order; replaying it');
    const view = toView(order);
    await this.idempotencyStore.markCompleted(completion(idempotency, orderId, view));
    return view;
  }
}

/** The response cached for replay; byte-identical to `OrderResponseDto.fromView` (a passthrough). */
function completion(idempotency: IdempotencyContext, orderId: string, view: OrderView) {
  return { ...idempotency, responseStatus: HttpStatus.CREATED, responseBody: view, orderId };
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
  });
}

// A pending wait must not hold the process open once the release it was racing has finished.
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms).unref());
