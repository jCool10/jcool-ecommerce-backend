import { Injectable } from '@nestjs/common';
import type { DrizzleTx } from '@shared/infrastructure/database/drizzle.tokens';
import { UnhandledEventError } from '../errors';
import type { DomainEventJob } from '../queue/domain-event.job';
import { OrderEventsHandler } from './order-events.handler';

/**
 * An effect runs inside the consumer's transaction — the same one that holds the inbox claim — so a
 * handler that fails un-marks the event and the redelivery runs it for real.
 */
export type DomainEventHandler = (job: DomainEventJob, tx: DrizzleTx) => Promise<void>;

const UNREGISTERED_EVENT_LABEL = 'unregistered';

/** Routes a consumed event to its effect. The one place that decides what this service reacts to. */
@Injectable()
export class DomainEventDispatcher {
  private readonly handlers: ReadonlyMap<string, DomainEventHandler>;

  constructor(orderEvents: OrderEventsHandler) {
    this.handlers = new Map<string, DomainEventHandler>([
      ['order.placed', (job) => orderEvents.record(job)],
      // The finalize outcomes. Audit-only for the same reason as order.placed: the finalizing
      // transaction already settled the stock, so re-applying anything here would double it.
      ['order.paid', (job) => orderEvents.record(job)],
      ['order.failed', (job) => orderEvents.record(job)],
      ['order.expired', (job) => orderEvents.record(job)],
      ['order.cancelled', (job) => orderEvents.record(job)],
      // A context that starts emitting its own events (Payment, say) registers here — and only once
      // it has an effect that is genuinely its consumer's to run, not a repeat of the producer's.
    ]);
  }

  /**
   * The event name as a metric label, folding anything unrecognised into one constant. The dispatch
   * table is the only bounded set of event names there is — a name off the wire is not — so a
   * producer emitting garbage would otherwise mint a time series per value.
   */
  label(eventType: string): string {
    return this.handlers.has(eventType) ? eventType : UNREGISTERED_EVENT_LABEL;
  }

  async dispatch(job: DomainEventJob, tx: DrizzleTx): Promise<void> {
    const handler = this.handlers.get(job.eventType);
    // Never ack an event we do not understand. A missing handler means a producer shipped ahead of
    // its consumer; swallowing it would drop the event with nothing but a log line to show for it,
    // whereas failing keeps it in the queue's failure path where it stays visible and replayable.
    if (!handler) throw new UnhandledEventError(job.eventType);

    await handler(job, tx);
  }
}
