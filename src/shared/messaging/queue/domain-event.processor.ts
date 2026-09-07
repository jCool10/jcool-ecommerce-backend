import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { DRIZZLE, type DrizzleDB } from '@shared/infrastructure/database/drizzle.tokens';
import { METRICS, type ConsumeResult, type MetricsPort } from '@shared/observability/metrics/metrics.port';
import { InboxStore } from '../inbox/inbox.store';
import { PermanentError } from '../errors';
import { DomainEventDispatcher } from '../handlers/domain-event.dispatcher';
import { withConsumeSpan } from './consume-span';
import { envelopeFields, isWellFormedEnvelope, type DomainEventJob, type PostCommitEffect } from './domain-event.job';
import { DOMAIN_EVENTS_CONSUMER } from './queue.constants';

const LOG_CONTEXT = 'DomainEventProcessor';

/**
 * Applies one delivered event, exactly once.
 *
 * The transport gives at-least-once: the relay can crash between publishing a row and marking it,
 * and the queue redelivers a job whose worker died mid-flight. Exactly-once *delivery* is not
 * available in a distributed system, so this collapses the duplicates instead — claim the message in
 * the inbox and run the effect in the SAME transaction, and a redelivery loses the claim and does
 * nothing. At-least-once in, exactly-once effect out — for effects inside the database.
 *
 * An effect outside it gets weaker odds, and cannot get better ones: no transaction spans Postgres
 * and an SMTP server. Such work is returned as a {@link PostCommitEffect} and run once the claim has
 * committed, which makes it at-most-once — a failure there is not retried, because the redelivery
 * that would carry it now finds the message already claimed. The alternative, sending inside the
 * transaction, trades a lost confirmation for duplicates of it plus a held connection per send.
 *
 * Kept separate from the worker that drives it so the behaviour above is testable one delivery at a
 * time, without a running queue — the same split as the relay and its scheduler.
 */
@Injectable()
export class DomainEventProcessor {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    @Inject(METRICS) private readonly metrics: MetricsPort,
    private readonly inbox: InboxStore,
    private readonly dispatcher: DomainEventDispatcher,
    private readonly logger: PinoLogger,
  ) {}

  async process(job: DomainEventJob): Promise<ConsumeResult> {
    let result: ConsumeResult;
    try {
      // Inside the try so a rejected envelope is counted as a failed consume like any other. Left
      // outside, the one failure that never even reaches a handler would be the one absent from the
      // counter that exists to make failures visible.
      assertEnvelope(job);

      result = await withConsumeSpan(job.eventType, job.traceparent, async (): Promise<ConsumeResult> => {
        let effect: PostCommitEffect | void = undefined;
        const outcome = await this.db.transaction(async (tx): Promise<ConsumeResult> => {
          const claimed = await this.inbox.claim(tx, {
            consumer: DOMAIN_EVENTS_CONSUMER,
            messageId: job.outboxId,
            eventType: job.eventType,
          });
          if (!claimed) return 'duplicate';

          effect = await this.dispatcher.dispatch(job, tx);
          return 'processed';
        });

        // Still inside the consume span, so what the effect reaches — an SMTP call, its breaker —
        // hangs off this event's trace rather than starting an orphan one. Outside the transaction,
        // which is the whole point: the connection is back in the pool before the send begins.
        if (typeof effect === 'function') await this.runPostCommit(job, effect);
        return outcome;
      });
    } catch (error) {
      // Counted before rethrowing: a pipeline where every consume throws would otherwise look
      // exactly like an idle one — the counter simply stops moving. The label falls back to a
      // constant for an unrecognised name, which is the only value here that is not bounded.
      this.metrics.recordEventConsumed(this.dispatcher.label(job.eventType), 'failed');
      throw error;
    }

    // Counted after the commit: an effect that rolled back has not been applied, and a metric saying
    // otherwise would hide exactly the failures this is here to surface. Through `label()` like
    // every other event_type label — a name off the wire is bounded only by the dispatch table.
    this.metrics.recordEventConsumed(this.dispatcher.label(job.eventType), result);
    if (result === 'duplicate') {
      this.logger.debug(
        // Qualified by `aggregateType` because the id means a different thing per producer — an
        // orderId for `order.*`, a paymentId for `payment.*` — and an unlabelled id sends whoever
        // reads this line looking for it in the wrong table.
        {
          context: LOG_CONTEXT,
          eventType: job.eventType,
          messageId: job.outboxId,
          aggregateType: job.aggregateType,
          aggregateId: job.aggregateId,
        },
        'duplicate delivery skipped',
      );
    }

    return result;
  }

  // The message is applied and committed by now, so nothing here may fail the consume: throwing
  // would send the job back for a redelivery that can only find its own claim and do nothing.
  private async runPostCommit(job: DomainEventJob, effect: PostCommitEffect): Promise<void> {
    try {
      await effect();
    } catch (error: unknown) {
      this.logger.error(
        { context: LOG_CONTEXT, eventType: job.eventType, messageId: job.outboxId, err: error },
        'post-commit effect failed and will not be retried',
      );
    }
  }
}

// Permanent by definition — the bytes will be identical on every redelivery — so a rejected envelope
// goes straight to the dead-letter queue rather than through the whole retry budget.
function assertEnvelope(job: DomainEventJob): void {
  if (!isWellFormedEnvelope(job)) {
    throw new PermanentError(`Malformed domain event envelope (fields: ${envelopeFields(job)})`);
  }
}
