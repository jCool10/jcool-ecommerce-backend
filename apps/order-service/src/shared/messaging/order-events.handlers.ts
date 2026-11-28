import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import {
  type DomainEventDispatcherPort,
  type DomainEventJob,
  type PostCommitEffect,
  UnhandledEventError,
} from '@jcool/messaging';
import { CATALOG_SKU_SNAPSHOT_EVENT } from '@jcool/internal-contracts/events/catalog-sku-snapshot';
import type { DrizzleTx } from '../../database';
import { CatalogSkuSnapshotHandler } from '../../modules/catalog/interface/queue/catalog-sku-snapshot.handler';
import { OrderPaidMailHandler } from '../../modules/order/interface/queue/order-paid-mail.handler';
import { OrderRefundedMailHandler } from '../../modules/order/interface/queue/order-refunded-mail.handler';
import { PaymentAuthorizedHandler } from '../../modules/order/interface/queue/payment-authorized.handler';

const LOG_CONTEXT = 'OrderEventsAudit';

/** The part of a handler that runs inside the consumer's transaction, next to the inbox claim. */
export type TransactionalStep = (tx: DrizzleTx) => Promise<PostCommitEffect | void>;

/** Runs before the transaction opens, for work that must not hold a pool connection. */
type PreparedHandler = (job: DomainEventJob) => Promise<TransactionalStep>;

/**
 * Audit only, on purpose. Every effect these events could trigger was applied by the transaction that
 * emitted them, so a consumer that "reacted" would apply it twice.
 */
@Injectable()
export class OrderEventsAudit {
  constructor(private readonly logger: PinoLogger) {
    logger.setContext(LOG_CONTEXT);
  }

  record(job: DomainEventJob): Promise<void> {
    this.logger.info(
      { eventType: job.eventType, orderId: job.aggregateId, messageId: job.outboxId, occurredAt: job.occurredAt },
      'order event consumed',
    );
    return Promise.resolve();
  }
}

// Retried until it lands, so it runs on every delivery, duplicates included, and must be safe to repeat.
const beforeClaim =
  (apply: (job: DomainEventJob) => Promise<void>): PreparedHandler =>
  async (job) => {
    await apply(job);
    return () => Promise.resolve();
  };

@Injectable()
export class OrderEventsDispatcher implements DomainEventDispatcherPort {
  private readonly handlers: ReadonlyMap<string, PreparedHandler>;

  constructor(
    audit: OrderEventsAudit,
    paymentAuthorized: PaymentAuthorizedHandler,
    orderPaidMail: OrderPaidMailHandler,
    orderRefundedMail: OrderRefundedMailHandler,
    catalogSkuSnapshot: CatalogSkuSnapshotHandler,
  ) {
    const recordOnly: PreparedHandler = (job) => Promise.resolve(() => audit.record(job));
    // The buyer's mail is still owed, so it comes back as a post-commit effect.
    const recordThenMail =
      (mail: { prepare(job: DomainEventJob): Promise<PostCommitEffect> }): PreparedHandler =>
      async (job) => {
        const message = await mail.prepare(job);
        return async () => {
          await audit.record(job);
          return message;
        };
      };
    this.handlers = new Map<string, PreparedHandler>([
      ['order.placed', recordOnly],
      ['order.paid', recordThenMail(orderPaidMail)],
      ['order.failed', recordOnly],
      ['order.expired', recordOnly],
      ['order.cancelled', recordOnly],
      ['order.refunded', recordThenMail(orderRefundedMail)],
      // Signals the order's saga, which treats a repeat as a no-op.
      ['payment.authorized', beforeClaim((job) => paymentAuthorized.forward(job))],
      // The api's catalog, upserted next to the inbox claim so a redelivery cannot apply it twice.
      [CATALOG_SKU_SNAPSHOT_EVENT, (job) => catalogSkuSnapshot.prepare(job)],
    ]);
  }

  /** The table is the bounded set of names, so anything else folds into one metric label. */
  handles(eventType: string): boolean {
    return this.handlers.has(eventType);
  }

  prepare(job: DomainEventJob): Promise<TransactionalStep> {
    const handler = this.handlers.get(job.eventType);
    // Never ack an event we do not understand: failing keeps it visible and replayable.
    if (!handler) return Promise.reject(new UnhandledEventError(job.eventType));
    return handler(job);
  }
}
