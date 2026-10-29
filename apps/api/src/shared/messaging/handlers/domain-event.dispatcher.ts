import { Injectable } from '@nestjs/common';
import {
  type DomainEventDispatcherPort,
  type DomainEventJob,
  type PostCommitEffect,
  UnhandledEventError,
} from '@jcool/messaging';
import { OrderPaidMailHandler } from '@modules/order/interface/queue/order-paid-mail.handler';
import { PaymentAuthorizedHandler } from '@modules/order/interface/queue/payment-authorized.handler';
import { CategoryRenamedHandler } from '@modules/product/interface/catalog/queue/category-renamed.handler';
import { ProductChangedHandler } from '@modules/product/interface/catalog/queue/product-changed.handler';
import type { DrizzleTx } from '@shared/infrastructure/database/drizzle.tokens';
import { OrderEventsHandler } from './order-events.handler';

/**
 * An effect runs inside the consumer's transaction — the same one holding the inbox claim — so a
 * handler that fails un-marks the event and the redelivery runs it for real. Work the transaction
 * cannot hold is returned instead; see {@link PostCommitEffect}.
 */
export type DomainEventHandler = (job: DomainEventJob, tx: DrizzleTx) => Promise<PostCommitEffect | void>;

/** A handler bound to its event, left with only the part that runs inside the transaction. */
export type TransactionalStep = (tx: DrizzleTx) => Promise<PostCommitEffect | void>;

/**
 * Runs before the transaction opens, for work that must not hold a pool connection — a call to
 * another service — and resolves into the step that runs inside it.
 */
type PreparedHandler = (job: DomainEventJob) => Promise<TransactionalStep>;

const inTransaction =
  (handle: DomainEventHandler): PreparedHandler =>
  (job) =>
    Promise.resolve((tx) => handle(job, tx));

// For work that must be retried until it lands, which a post-commit effect never is: a failure rejects
// before the claim commits. It runs on every delivery, duplicates included, and nothing it does rolls
// back with the claim, so it must be safe to repeat.
const beforeClaim =
  (apply: (job: DomainEventJob) => Promise<void>): PreparedHandler =>
  async (job) => {
    await apply(job);
    return () => Promise.resolve();
  };

/** One table for both queues the api consumes: each only ever delivers the events routed to it. */
@Injectable()
export class DomainEventDispatcher implements DomainEventDispatcherPort {
  private readonly handlers: ReadonlyMap<string, PreparedHandler>;

  constructor(
    orderEvents: OrderEventsHandler,
    paymentAuthorized: PaymentAuthorizedHandler,
    orderPaidMail: OrderPaidMailHandler,
    productChanged: ProductChangedHandler,
    categoryRenamed: CategoryRenamedHandler,
  ) {
    this.handlers = new Map<string, PreparedHandler>([
      // Order events only record: the saga already applied every effect before emitting them.
      ['order.placed', inTransaction((job) => orderEvents.record(job))],
      // The buyer's confirmation is still owed, which is why order.paid hands back an effect
      // instead of sending inline.
      [
        'order.paid',
        async (job) => {
          const confirmation = await orderPaidMail.prepare(job);
          return async () => {
            await orderEvents.record(job);
            return confirmation;
          };
        },
      ],
      ['order.failed', inTransaction((job) => orderEvents.record(job))],
      ['order.expired', inTransaction((job) => orderEvents.record(job))],
      ['order.cancelled', inTransaction((job) => orderEvents.record(job))],
      // Signals the order's saga, which treats a repeat as a no-op.
      ['payment.authorized', beforeClaim((job) => paymentAuthorized.forward(job))],
      ['catalog.product.changed', beforeClaim((job) => productChanged.apply(job))],
      ['catalog.category.renamed', beforeClaim((job) => categoryRenamed.apply(job))],
    ]);
  }

  /**
   * The dispatch table is the only bounded set of event names there is — a name off the wire is not
   * — so anything unrecognised folds into one label rather than minting a time series per value.
   */
  handles(eventType: string): boolean {
    return this.handlers.has(eventType);
  }

  async prepare(job: DomainEventJob): Promise<TransactionalStep> {
    const handler = this.handlers.get(job.eventType);
    // Never ack an event we do not understand: failing keeps it in the queue's failure path, where
    // it stays visible and replayable, rather than dropping it with only a log line to show for it.
    if (!handler) throw new UnhandledEventError(job.eventType);

    return handler(job);
  }
}
