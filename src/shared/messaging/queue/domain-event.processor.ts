import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { DRIZZLE, type DrizzleDB } from '@shared/infrastructure/database/drizzle.tokens';
import { METRICS, type ConsumeResult, type MetricsPort } from '@shared/observability/metrics/metrics.port';
import { InboxStore } from '../inbox/inbox.store';
import { DomainEventDispatcher } from '../handlers/domain-event.dispatcher';
import { withConsumeSpan } from './consume-span';
import type { DomainEventJob } from './domain-event.job';
import { DOMAIN_EVENTS_CONSUMER } from './queue.constants';

const LOG_CONTEXT = 'DomainEventProcessor';

/**
 * Applies one delivered event, exactly once.
 *
 * The transport gives at-least-once: the relay can crash between publishing a row and marking it,
 * and the queue redelivers a job whose worker died mid-flight. Exactly-once *delivery* is not
 * available in a distributed system, so this collapses the duplicates instead — claim the message in
 * the inbox and run the effect in the SAME transaction, and a redelivery loses the claim and does
 * nothing. At-least-once in, exactly-once effect out.
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
    assertEnvelope(job);

    let result: ConsumeResult;
    try {
      result = await withConsumeSpan(job.eventType, job.traceparent, () =>
        this.db.transaction(async (tx): Promise<ConsumeResult> => {
          const claimed = await this.inbox.claim(tx, {
            consumer: DOMAIN_EVENTS_CONSUMER,
            messageId: job.outboxId,
            eventType: job.eventType,
          });
          if (!claimed) return 'duplicate';

          await this.dispatcher.dispatch(job, tx);
          return 'processed';
        }),
      );
    } catch (error) {
      // Counted before rethrowing: a pipeline where every consume throws would otherwise look
      // exactly like an idle one — the counter simply stops moving. The label falls back to a
      // constant for an unrecognised name, which is the only value here that is not bounded.
      this.metrics.recordEventConsumed(this.labelFor(job.eventType), 'failed');
      throw error;
    }

    // Counted after the commit: an effect that rolled back has not been applied, and a metric saying
    // otherwise would hide exactly the failures this is here to surface.
    this.metrics.recordEventConsumed(job.eventType, result);
    if (result === 'duplicate') {
      this.logger.debug(
        { context: LOG_CONTEXT, eventType: job.eventType, messageId: job.outboxId },
        'duplicate delivery skipped',
      );
    }

    return result;
  }

  private labelFor(eventType: string): string {
    return this.dispatcher.knows(eventType) ? eventType : 'unregistered';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The envelope arrives as JSON from Redis, so its type is a claim rather than a guarantee. Fail
// early with something readable instead of letting a bad id surface as a Postgres cast error deep
// inside the claim — a failure no redelivery can ever fix. Field names only: the payload can carry
// customer data, and this message ends up in logs.
function assertEnvelope(job: DomainEventJob): void {
  if (!UUID.test(job?.outboxId ?? '') || !job?.eventType) {
    throw new Error(`Malformed domain event envelope (fields: ${Object.keys(job ?? {}).join(',') || 'none'})`);
  }
}
