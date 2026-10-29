import { Inject, Injectable } from '@nestjs/common';
import { UnrecoverableError, type Job, type Queue } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import { toError } from '@jcool/kernel';
import { METRICS, type DeadLetterReason, type MetricsPort } from '@jcool/metrics-port';
import { MESSAGING_CONSUMERS, MESSAGING_QUEUES } from '../messaging.tokens';
import { type DomainEventJob, jobIdFor } from './domain-event.job';
import { type Consumers, consumerOf, eventLabel } from './queue-definition';

const LOG_CONTEXT = 'DeadLetterRouter';

export interface DeadLetterJob extends DomainEventJob {
  failedReason: string;
  attemptsMade: number;
  failedAt: string;
}

/**
 * "Is this the end of the road" is BullMQ's own verdict, read back rather than recomputed:
 * `Job.moveToFailed` sets `finishedOn` only on the branch where it did NOT schedule another attempt,
 * so it covers both a spent budget and a PermanentError that skipped the budget entirely.
 * Re-deriving it from `attemptsMade >= opts.attempts` would get the second case wrong.
 */
@Injectable()
export class DeadLetterRouter {
  constructor(
    @Inject(MESSAGING_QUEUES) private readonly queues: ReadonlyMap<string, Queue>,
    @Inject(METRICS) private readonly metrics: MetricsPort,
    @Inject(MESSAGING_CONSUMERS) private readonly consumers: Consumers,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(LOG_CONTEXT);
  }

  async route(queue: string, job: Job<DomainEventJob>, error: Error): Promise<void> {
    const { definition, dispatcher } = consumerOf(this.consumers, queue);
    // `job.name` is the event type straight off the wire; only the dispatch table bounds it.
    const eventType = eventLabel(dispatcher, job.name);
    const messageId = job.data?.outboxId ?? job.id;

    if (job.finishedOn === undefined) {
      this.metrics.recordConsumeRetry(eventType);
      this.logger.warn(
        { err: error, eventType: job.name, messageId, attemptsMade: job.attemptsMade },
        'domain event consume failed, will retry',
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
      // Keyed on the message, not the delivery, so a message that poisons twice occupies one slot.
      // The remove is what makes that slot hold the LATEST diagnosis: `add` on an existing jobId is
      // silently ignored, so without it an operator would debug the first failure. Safe to lose the
      // entry in between — the main queue holds this job in its failed set for a week either way.
      const deadLetterQueue = this.queues.get(definition.dlq);
      if (!deadLetterQueue) throw new Error(`dead-letter queue ${definition.dlq} was never opened`);
      const slot = job.data?.outboxId ? jobIdFor(job.data.outboxId) : job.id;
      if (slot) await deadLetterQueue.remove(slot);
      await deadLetterQueue.add(job.name, dead, { jobId: slot });
      this.metrics.recordDeadLetter(eventType, reason);
      this.logger.error(
        { err: error, eventType: job.name, messageId, attemptsMade: job.attemptsMade, reason },
        'domain event moved to the dead-letter queue',
      );
    } catch (caught: unknown) {
      // Best effort by construction — one more write to the Redis that just failed us. The main
      // queue keeps the failed job for a week, so a lost move costs visibility, not the message.
      // Logged at error because a swallowed move is only ever noticed by a human reading this line.
      this.logger.error(
        { err: toError(caught), eventType: job.name, messageId, reason },
        'failed to move a domain event to the dead-letter queue',
      );
    }
  }
}
