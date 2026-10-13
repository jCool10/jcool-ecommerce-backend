import { Inject, Injectable } from '@nestjs/common';
import { DomainError } from '@jcool/kernel';
import type { DrizzleTx } from '@shared/infrastructure/database/drizzle.tokens';
import { ID_GENERATOR, mintOne, type IdGeneratorPort } from '@shared/identity/id-generator.port';
import { OUTBOX_WRITER, type OutboxRecord, type OutboxWriterPort } from '@shared/messaging/outbox/outbox-writer.port';
import type { OrderChange } from '../../domain/checkout-saga';
import type { Order } from '../../domain/order.entity';
import { OrderStatus } from '../../domain/order-status';
import { toFinalizedOutboxRecord, toPlacedOutboxRecord } from '../order-outbox.mapper';
import { ORDER_REPOSITORY, type OrderRepositoryPort } from '../ports/order-repository.port';

const EVENTFUL_STATUSES: ReadonlySet<OrderStatus> = new Set([
  OrderStatus.PENDING,
  OrderStatus.PAID,
  OrderStatus.FAILED,
  OrderStatus.EXPIRED,
  OrderStatus.CANCELLED,
]);

/**
 * `already`: an earlier attempt committed this exact change. `stale`: the order moved somewhere else,
 * which only a bug can cause, since the saga is the one writer of an order past RESERVING.
 */
export type OrderWriteOutcome = 'written' | 'already' | 'stale';

export interface OrderWrite {
  orderId: string;
  from: OrderStatus;
  change: OrderChange;
  now?: Date;
  inTx?: (tx: DrizzleTx, order: Order) => Promise<void>;
}

export class SagaOrderMissingError extends DomainError {
  constructor(orderId: string) {
    super(`Checkout saga order ${orderId} does not exist`);
    this.name = 'SagaOrderMissingError';
  }
}

/** Every order write the saga makes: CAS on the source status, the event, and the key, in one tx. */
@Injectable()
export class CheckoutOrderWriter {
  constructor(
    @Inject(ORDER_REPOSITORY) private readonly orders: OrderRepositoryPort,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriterPort,
    @Inject(ID_GENERATOR) private readonly ids: IdGeneratorPort,
  ) {}

  async apply({ orderId, from, change, now = new Date(), inTx }: OrderWrite): Promise<OrderWriteOutcome> {
    // Minted before the transaction, so no row lock waits on the id service.
    const eventId = EVENTFUL_STATUSES.has(change.status) ? await mintOne(this.ids) : undefined;
    return this.orders.withTransaction(async (tx) => {
      const order = await this.orders.findByIdForUpdate(orderId, tx);
      if (!order) throw new SagaOrderMissingError(orderId);
      if (order.status === change.status) return 'already';
      if (order.status !== from) return 'stale';

      const changed = applyChange(order, change, now);
      await this.orders.saveStatus(changed, tx);
      if (changed.status === OrderStatus.REJECTED) {
        await this.orders.clearIdempotencyKey(orderId, tx);
      }
      const record = eventFor(changed);
      if (record) await this.outbox.append(tx, record, eventId);
      await inTx?.(tx, changed);
      return 'written';
    });
  }
}

function applyChange(order: Order, change: OrderChange, now: Date): Order {
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

function eventFor(order: Order): OutboxRecord | null {
  if (!EVENTFUL_STATUSES.has(order.status)) return null;
  return order.status === OrderStatus.PENDING
    ? toPlacedOutboxRecord(order.toPlacedEvent())
    : toFinalizedOutboxRecord(order.toFinalizedEvent());
}
