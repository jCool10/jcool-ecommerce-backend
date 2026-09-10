import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { DRIZZLE, type DrizzleDB } from '@shared/infrastructure/database/drizzle.tokens';
import { METRICS, type ConsumeResult, type MetricsPort } from '@shared/observability/metrics/metrics.port';
import { InboxStore } from '../inbox/inbox.store';
import { PermanentError } from '../errors';
import {
  DOMAIN_EVENT_DISPATCHER,
  EVENT_LABEL_REGISTRY,
  type DomainEventDispatcherPort,
  type EventLabelRegistry,
} from './domain-event-dispatcher.port';
import { withConsumeSpan } from './consume-span';
import { envelopeFields, isWellFormedEnvelope, type DomainEventJob, type PostCommitEffect } from './domain-event.job';
import { DOMAIN_EVENTS_CONSUMER } from './queue.constants';

const LOG_CONTEXT = 'DomainEventProcessor';

/**
 * The transport gives at-least-once, so duplicates are collapsed rather than prevented: the inbox
 * claim and the effect share ONE transaction, and a redelivery loses the claim and does nothing.
 *
 * An effect outside the database cannot get those odds — no transaction spans Postgres and an SMTP
 * server. Returned as a {@link PostCommitEffect} and run after the claim commits, it is at-most-once:
 * a failure there is never retried, because the redelivery finds the message already claimed. Sending
 * inside the transaction instead trades a lost confirmation for duplicates plus a held connection.
 */
@Injectable()
export class DomainEventProcessor {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    @Inject(METRICS) private readonly metrics: MetricsPort,
    private readonly inbox: InboxStore,
    @Inject(DOMAIN_EVENT_DISPATCHER) private readonly dispatcher: DomainEventDispatcherPort,
    @Inject(EVENT_LABEL_REGISTRY) private readonly eventLabels: EventLabelRegistry,
    private readonly logger: PinoLogger,
  ) {}

  async process(job: DomainEventJob): Promise<ConsumeResult> {
    let result: ConsumeResult;
    try {
      // Inside the try so a rejected envelope is counted as a failed consume like any other:
      // otherwise the one failure that never reaches a handler is the one missing from the counter.
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

        // Still inside the consume span so the effect hangs off this event's trace, but outside the
        // transaction so the connection is back in the pool before the send begins.
        if (typeof effect === 'function') await this.runPostCommit(job, effect);
        return outcome;
      });
    } catch (error) {
      // Counted before rethrowing: a pipeline where every consume throws would otherwise look
      // exactly like an idle one — the counter simply stops moving.
      this.metrics.recordEventConsumed(this.eventLabels.label(job.eventType), 'failed');
      throw error;
    }

    // Counted after the commit: an effect that rolled back has not been applied, and a metric saying
    // otherwise would hide exactly the failures this is here to surface.
    this.metrics.recordEventConsumed(this.eventLabels.label(job.eventType), result);
    if (result === 'duplicate') {
      this.logger.debug(
        // Qualified by `aggregateType` because the id means a different thing per producer — an
        // orderId for `order.*`, a paymentId for `payment.*` — and unlabelled it sends a reader
        // looking in the wrong table.
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
