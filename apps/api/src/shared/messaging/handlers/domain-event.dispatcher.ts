import { Injectable } from '@nestjs/common';
import { OrderPaidMailHandler } from '@modules/order/interface/queue/order-paid-mail.handler';
import { PaymentAuthorizedHandler } from '@modules/order/interface/queue/payment-authorized.handler';
import { CategoryRenamedHandler } from '@modules/product/interface/catalog/queue/category-renamed.handler';
import { ProductChangedHandler } from '@modules/product/interface/catalog/queue/product-changed.handler';
import type { DrizzleTx } from '@shared/infrastructure/database/drizzle.tokens';
import { UnhandledEventError } from '../errors';
import type { DomainEventJob, PostCommitEffect } from '../queue/domain-event.job';
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

const UNREGISTERED_EVENT_LABEL = 'unregistered';

@Injectable()
export class DomainEventDispatcher {
  private readonly handlers: ReadonlyMap<string, PreparedHandler>;

  constructor(
    orderEvents: OrderEventsHandler,
    paymentAuthorized: PaymentAuthorizedHandler,
    orderPaidMail: OrderPaidMailHandler,
    productChanged: ProductChangedHandler,
    categoryRenamed: CategoryRenamedHandler,
  ) {
    this.handlers = new Map<string, PreparedHandler>([
      ['order.placed', inTransaction((job) => orderEvents.record(job))],
      // No DB effect, for the same reason as order.placed: the saga already settled the stock, so
      // re-applying anything here would double it. The buyer's confirmation is still owed, which is
      // why order.paid hands back an effect instead of sending inline.
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
      // Unlike the above, this carries an effect this consumer genuinely owns: the producing
      // transaction moved money and nothing else, leaving the saga still to move.
      ['payment.authorized', (job) => paymentAuthorized.prepare(job)],
      ['catalog.product.changed', beforeClaim((job) => productChanged.apply(job))],
      ['catalog.category.renamed', beforeClaim((job) => categoryRenamed.apply(job))],
    ]);
  }

  /**
   * The dispatch table is the only bounded set of event names there is — a name off the wire is not
   * — so anything unrecognised folds into one constant rather than minting a time series per value.
   */
  label(eventType: string): string {
    return this.handlers.has(eventType) ? eventType : UNREGISTERED_EVENT_LABEL;
  }

  async prepare(job: DomainEventJob): Promise<TransactionalStep> {
    const handler = this.handlers.get(job.eventType);
    // Never ack an event we do not understand: failing keeps it in the queue's failure path, where
    // it stays visible and replayable, rather than dropping it with only a log line to show for it.
    if (!handler) throw new UnhandledEventError(job.eventType);

    return handler(job);
  }
}
