import { Inject, Injectable } from '@nestjs/common';
import { METRICS, type MetricsPort } from '@jcool/metrics-port';
import type { DrizzleTx } from '@shared/infrastructure/database/drizzle.tokens';
import { ID_GENERATOR, mintOne, type IdGeneratorPort } from '@shared/identity/id-generator.port';
import { OUTBOX_WRITER, type OutboxRecord, type OutboxWriterPort } from '@shared/messaging/outbox/outbox-writer.port';
import { scheduleNext, type OrderChange, type SagaTransition } from '../../domain/checkout-saga';
import type { Order } from '../../domain/order.entity';
import { OrderStatus } from '../../domain/order-status';
import { toFinalizedOutboxRecord, toPlacedOutboxRecord } from '../order-outbox.mapper';
import {
  CHECKOUT_SAGA_REPOSITORY,
  type CheckoutSaga,
  type CheckoutSagaRepositoryPort,
  type CheckoutSagaUpdate,
} from '../ports/checkout-saga-repository.port';
import { ORDER_REPOSITORY, type OrderRepositoryPort } from '../ports/order-repository.port';
import { CHECKOUT_SAGA_SETTINGS, type CheckoutSagaSettings } from './checkout-saga.settings';

const EVENTFUL_STATUSES: ReadonlySet<OrderStatus> = new Set([
  OrderStatus.PENDING,
  OrderStatus.PAID,
  OrderStatus.FAILED,
  OrderStatus.EXPIRED,
  OrderStatus.CANCELLED,
]);

export interface ApplyLeasedOptions {
  now?: Date;
  /** Runs inside the apply's transaction, after the saga and order rows are written. */
  inTx?: (tx: DrizzleTx, order: Order | null) => Promise<void>;
}

/**
 * The one place a saga transition is persisted, with the order row it changes and the event that
 * change emits, in one transaction. The order row is always locked before the saga row.
 */
@Injectable()
export class CheckoutSagaWriter {
  constructor(
    @Inject(ORDER_REPOSITORY) private readonly orders: OrderRepositoryPort,
    @Inject(CHECKOUT_SAGA_REPOSITORY) private readonly sagas: CheckoutSagaRepositoryPort,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriterPort,
    @Inject(ID_GENERATOR) private readonly ids: IdGeneratorPort,
    @Inject(CHECKOUT_SAGA_SETTINGS) private readonly settings: CheckoutSagaSettings,
    @Inject(METRICS) private readonly metrics: MetricsPort,
  ) {}

  /** The lease holder's write. False when another write moved the saga since `lease` was read. */
  async applyLeased(
    lease: CheckoutSaga,
    transition: SagaTransition,
    options: ApplyLeasedOptions = {},
  ): Promise<boolean> {
    const now = options.now ?? new Date();
    const change = transition.order;
    // Minted before the transaction, so no row lock waits on the id service.
    const eventId = emitsEvent(change) ? await mintOne(this.ids) : undefined;
    const applied = await this.orders.withTransaction(async (tx) => {
      const order = change ? await this.lockOrder(tx, lease.orderId) : null;
      if (!(await this.sagas.applyLeased(tx, lease.orderId, lease.version, this.updateFor(transition, lease, now)))) {
        return false;
      }
      const changed = order && change ? await this.changeOrder(tx, order, change, now, eventId) : null;
      await options.inTx?.(tx, changed);
      return true;
    });
    if (applied) this.reportCommitted(transition);
    return applied;
  }

  /**
   * A write from outside any advance, inside the caller's transaction, which must already hold the
   * order and saga row locks. The lease is left alone; the version bump makes its holder stop.
   */
  async rewrite(
    tx: DrizzleTx,
    order: Order,
    saga: CheckoutSaga,
    transition: SagaTransition,
    { now, eventId }: { now: Date; eventId?: string },
  ): Promise<Order> {
    await this.sagas.rewrite(tx, saga.orderId, this.updateFor(transition, saga, now));
    return transition.order ? this.changeOrder(tx, order, transition.order, now, eventId) : order;
  }

  /** Counters for a transition whose transaction has committed. */
  reportCommitted(transition: SagaTransition): void {
    if (transition.cause !== null) this.metrics.recordCompensation(transition.cause);
  }

  private updateFor(transition: SagaTransition, saga: CheckoutSaga, now: Date): CheckoutSagaUpdate {
    return {
      step: transition.step,
      pendingCompensations: transition.pendingCompensations,
      lastError: transition.lastError,
      ...scheduleNext(transition.wake, saga, now, this.settings.timing),
    };
  }

  private async lockOrder(tx: DrizzleTx, orderId: string): Promise<Order> {
    const order = await this.orders.findByIdForUpdate(orderId, tx);
    if (!order) throw new Error(`Checkout saga ${orderId} has no order`);
    return order;
  }

  private async changeOrder(
    tx: DrizzleTx,
    order: Order,
    change: OrderChange,
    now: Date,
    eventId: string | undefined,
  ): Promise<Order> {
    const changed = applyOrderChange(order, change, now);
    await this.orders.saveStatus(changed, tx);
    if (changed.status === OrderStatus.REJECTED) {
      await this.orders.clearIdempotencyKey(changed.id as string, tx);
    }
    const record = eventFor(changed);
    if (record) await this.outbox.append(tx, record, eventId);
    return changed;
  }
}

function applyOrderChange(order: Order, change: OrderChange, now: Date): Order {
  switch (change.status) {
    case OrderStatus.PENDING:
      return order.confirmPlaced();
    case OrderStatus.CONFIRMING:
      return order.confirming();
    case OrderStatus.REJECTED:
      return order.reject(change.reason, now);
    default:
      return order.settle(change.status, { now, reason: change.reason });
  }
}

function emitsEvent(change: OrderChange | null): boolean {
  return change !== null && EVENTFUL_STATUSES.has(change.status);
}

function eventFor(order: Order): OutboxRecord | null {
  if (!EVENTFUL_STATUSES.has(order.status)) return null;
  return order.status === OrderStatus.PENDING
    ? toPlacedOutboxRecord(order.toPlacedEvent())
    : toFinalizedOutboxRecord(order.toFinalizedEvent());
}
