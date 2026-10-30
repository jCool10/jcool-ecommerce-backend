import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { toError } from '@jcool/kernel';
import { METRICS, type ConsumeResult, type MetricsPort } from '@jcool/metrics-port';
import { DRIZZLE } from '@jcool/platform/database';
import { PermanentError } from '../errors';
import { InboxStore } from '../inbox/inbox.store';
import type { MessagingDb } from '../messaging.database';
import { MESSAGING_CONSUMERS } from '../messaging.tokens';
import { withConsumeSpan } from './consume-span';
import { envelopeFields, isWellFormedEnvelope, type DomainEventJob, type PostCommitEffect } from './domain-event.job';
import { type Consumers, consumerOf, eventLabel } from './queue-definition';

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
    @Inject(DRIZZLE) private readonly db: MessagingDb,
    @Inject(METRICS) private readonly metrics: MetricsPort,
    private readonly inboxStore: InboxStore,
    @Inject(MESSAGING_CONSUMERS) private readonly consumers: Consumers,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(LOG_CONTEXT);
  }

  /** `queue` is the one the job was delivered on; its consumer group owns the inbox claim. */
  async process(job: DomainEventJob, queue: string): Promise<ConsumeResult> {
    const { definition, dispatcher } = consumerOf(this.consumers, queue);
    const label = (eventType: string) => eventLabel(dispatcher, eventType);
    let result: ConsumeResult;
    try {
      // Inside the try so a rejected envelope is counted as a failed consume like any other:
      // otherwise the one failure that never reaches a handler is the one missing from the counter.
      assertEnvelope(job);

      result = await withConsumeSpan(job.eventType, job.traceparent, async (): Promise<ConsumeResult> => {
        // Settled rather than awaited: a failure is only the delivery's once the claim says this is not
        // a duplicate, or an already-applied message would ride the retry ladder into the DLQ.
        const prepared = await dispatcher.prepare(job).then(
          (step) => ({ step }),
          (error: unknown) => ({ error }),
        );

        let effect: PostCommitEffect | void = undefined;
        const outcome = await this.db.transaction(async (tx): Promise<ConsumeResult> => {
          const claimed = await this.inboxStore.claim(tx, {
            consumer: definition.consumer,
            messageId: job.outboxId,
            eventType: job.eventType,
          });
          if (!claimed) return 'duplicate';
          if ('error' in prepared) throw prepared.error;

          // The handler was written against the service's own tx type; at runtime it is this one.
          effect = await prepared.step(tx as never);
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
      this.metrics.recordEventConsumed(label(job.eventType), 'failed');
      throw error;
    }

    // Counted after the commit: an effect that rolled back has not been applied, and a metric saying
    // otherwise would hide exactly the failures this is here to surface.
    this.metrics.recordEventConsumed(label(job.eventType), result);
    if (result === 'duplicate') {
      this.logger.debug(
        // Qualified by `aggregateType` because the id means a different thing per producer — an
        // orderId for `order.*`, a paymentId for `payment.*` — and unlabelled it sends a reader
        // looking in the wrong table.
        {
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
        { eventType: job.eventType, messageId: job.outboxId, err: toError(error) },
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
