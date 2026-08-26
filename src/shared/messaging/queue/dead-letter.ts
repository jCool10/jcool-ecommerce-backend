import { Inject, Injectable } from '@nestjs/common';
import { UnrecoverableError, type Job, type Queue } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import { METRICS, type DeadLetterReason, type MetricsPort } from '@shared/observability/metrics/metrics.port';
import { DomainEventDispatcher } from '../handlers/domain-event.dispatcher';
import type { DomainEventJob } from './domain-event.job';
import { DOMAIN_EVENTS_DLQ_QUEUE } from './queue.constants';

const LOG_CONTEXT = 'DeadLetterRouter';

/** A dead-lettered message: the original envelope plus why it stopped being tried. */
export interface DeadLetterJob extends DomainEventJob {
  failedReason: string;
  attemptsMade: number;
  failedAt: string;
}

/**
 * Decides what happens to a failed delivery: let the queue retry it, or park it where retrying has
 * stopped being useful.
 *
 * The distinction is BullMQ's own, read back rather than recomputed. `Job.moveToFailed` sets
 * `finishedOn` only on the branch where it did NOT schedule another attempt, so that field answers
 * "is this the end of the road" for both ways a message gets there — a budget spent on a dependency
 * that never recovered, and a PermanentError that skipped the budget entirely. Re-deriving it from
 * `attemptsMade >= opts.attempts` would get the second case wrong.
 */
@Injectable()
export class DeadLetterRouter {
  constructor(
    @Inject(DOMAIN_EVENTS_DLQ_QUEUE) private readonly dlq: Queue,
    @Inject(METRICS) private readonly metrics: MetricsPort,
    private readonly dispatcher: DomainEventDispatcher,
    private readonly logger: PinoLogger,
  ) {}

  async route(job: Job<DomainEventJob>, error: Error): Promise<void> {
    // `job.name` is the event type straight off the wire; only the dispatch table bounds it.
    const eventType = this.dispatcher.label(job.name);
    const messageId = job.data?.outboxId ?? job.id;

    if (job.finishedOn === undefined) {
      this.metrics.recordConsumeRetry(eventType);
      this.logger.warn(
        { context: LOG_CONTEXT, err: error, eventType: job.name, messageId, attemptsMade: job.attemptsMade },
        `domain event consume failed, will retry: ${error.message}`,
      );
      return;
    }

    // `UnrecoverableError` rather than our own PermanentError: BullMQ raises its own for a deferred
    // failure or a job that exceeded maxStartedAttempts, and labelling those `attempts_exhausted`
    // would claim a retry budget was spent when none was.
    const reason: DeadLetterReason = error instanceof UnrecoverableError ? 'permanent' : 'attempts_exhausted';
    const dead: DeadLetterJob = {
      ...job.data,
      failedReason: error.message,
      attemptsMade: job.attemptsMade,
      failedAt: new Date().toISOString(),
    };

    try {
      // Keyed on the message, not the delivery: a message that poisons twice occupies one slot here
      // rather than growing the queue it was supposed to make inspectable. Dropping the previous
      // entry first is what makes that slot hold the LATEST diagnosis — `add` on an id that already
      // exists is silently ignored, so without this the operator would read the first failure and
      // debug a reason that may no longer be the one. Safe to lose the entry in between: the main
      // queue is holding this job in its failed set for a week either way.
      if (messageId) await this.dlq.remove(messageId);
      await this.dlq.add(job.name, dead, { jobId: messageId });
      this.metrics.recordDeadLetter(eventType, reason);
      this.logger.error(
        { context: LOG_CONTEXT, err: error, eventType: job.name, messageId, attemptsMade: job.attemptsMade, reason },
        `domain event moved to the dead-letter queue: ${error.message}`,
      );
    } catch (caught: unknown) {
      // Best effort by construction — this is one more write to the Redis that just failed us. The
      // main queue keeps the failed job for a week, so a lost move costs visibility, not the
      // message. Logged at error because that backstop needs a human to notice it.
      this.logger.error(
        { context: LOG_CONTEXT, err: caught, eventType: job.name, messageId, reason },
        `failed to move a domain event to the dead-letter queue: ${caught instanceof Error ? caught.message : String(caught)}`,
      );
    }
  }
}
