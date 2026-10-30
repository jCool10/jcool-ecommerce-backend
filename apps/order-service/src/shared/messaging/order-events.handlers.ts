import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import {
  type DomainEventDispatcherPort,
  type DomainEventJob,
  type PostCommitEffect,
  UnhandledEventError,
} from '@jcool/messaging';
import type { DrizzleTx } from '../../database';
import { OrderPaidMailHandler } from '../../modules/order/interface/queue/order-paid-mail.handler';
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
  ) {
    const recordOnly: PreparedHandler = (job) => Promise.resolve(() => audit.record(job));
    this.handlers = new Map<string, PreparedHandler>([
      ['order.placed', recordOnly],
      // The confirmation mail is still owed, so it comes back as a post-commit effect.
      [
        'order.paid',
        async (job) => {
          const confirmation = await orderPaidMail.prepare(job);
          return async () => {
            await audit.record(job);
            return confirmation;
          };
        },
      ],
      ['order.failed', recordOnly],
      ['order.expired', recordOnly],
      ['order.cancelled', recordOnly],
      // Signals the order's saga, which treats a repeat as a no-op.
      ['payment.authorized', beforeClaim((job) => paymentAuthorized.forward(job))],
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
