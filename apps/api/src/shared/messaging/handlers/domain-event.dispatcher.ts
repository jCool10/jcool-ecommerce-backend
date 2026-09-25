import { Injectable } from '@nestjs/common';
import { ProductChangedHandler } from '@modules/catalog/interface/queue/product-changed.handler';
import { OrderPaidMailHandler } from '@modules/order/interface/queue/order-paid-mail.handler';
import { PaymentEventsHandler } from '@modules/order/interface/queue/payment-events.handler';
import { OrderCancelledHandler } from '@modules/payment/interface/queue/order-cancelled.handler';
import { OrderExpiredHandler } from '@modules/payment/interface/queue/order-expired.handler';
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

const UNREGISTERED_EVENT_LABEL = 'unregistered';

@Injectable()
export class DomainEventDispatcher {
  private readonly handlers: ReadonlyMap<string, PreparedHandler>;

  constructor(
    orderEvents: OrderEventsHandler,
    paymentEvents: PaymentEventsHandler,
    orderExpired: OrderExpiredHandler,
    orderCancelled: OrderCancelledHandler,
    orderPaidMail: OrderPaidMailHandler,
    productChanged: ProductChangedHandler,
  ) {
    this.handlers = new Map<string, PreparedHandler>([
      ['order.placed', inTransaction((job) => orderEvents.record(job))],
      // No DB effect, for the same reason as order.placed: the finalizing transaction already
      // settled the stock, so re-applying anything here would double it. The buyer's confirmation
      // is still owed, which is why order.paid hands back an effect instead of sending inline.
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
      // The two exceptions: an order that dies unpaid settles its stock but cannot reach the gateway,
      // so the checkout session it leaves open is an effect still owed, and only Payment can apply it.
      // Two handlers because the logs tell the two deaths apart.
      [
        'order.expired',
        inTransaction(async (job, tx) => {
          await orderEvents.record(job);
          await orderExpired.close(job, tx);
        }),
      ],
      [
        'order.cancelled',
        inTransaction(async (job, tx) => {
          await orderEvents.record(job);
          await orderCancelled.close(job, tx);
        }),
      ],
      // Unlike the above, these carry an effect this consumer genuinely owns: the producing
      // transaction moved money and nothing else, leaving the order still to settle.
      ['payment.succeeded', inTransaction((job, tx) => paymentEvents.settle(job, tx))],
      ['payment.failed', inTransaction((job, tx) => paymentEvents.settle(job, tx))],
      // The index write happens before the claim, never as a post-commit effect: a failure there must
      // roll the claim back and retry, and a claimed message is never retried.
      [
        'catalog.product.changed',
        async (job) => {
          await productChanged.apply(job);
          return () => Promise.resolve();
        },
      ],
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
