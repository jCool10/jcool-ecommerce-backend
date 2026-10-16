import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClsService } from 'nestjs-cls';
import { PinoLogger } from 'nestjs-pino';
import { METRICS, type DeadLetterReason, type MetricsPort } from '@jcool/metrics-port';
import { requireIntConfig } from '@jcool/platform/config';
import { runInJobContext } from '@jcool/platform/observability';
import { PermanentError } from '../errors';
import { DomainEventDispatcher } from '../handlers/domain-event.dispatcher';
import { DomainEventProcessor } from '../queue/domain-event.processor';
import { ConsumerRetryStore, type LeasedRetry } from './consumer-retry.store';
import { rootCause } from './retry-error';
import { retryLadderFrom, retryPolicyFor, type RetryLadderConfig } from './retry-policy';

const LOG_CONTEXT = 'RetryPoller';

export interface RetryTickSummary {
  leased: number;
  processed: number;
  rescheduled: number;
  buried: number;
  /** Results another poller's lease overtook; that poller owns the row now. */
  lost: number;
}

type AttemptOutcome = Exclude<keyof RetryTickSummary, 'leased'>;

/**
 * Runs each due attempt outside any transaction: the lease is one self-committing statement, so a
 * slow handler holds a row's lease, never its lock.
 */
@Injectable()
export class RetryPoller {
  private readonly ladder: RetryLadderConfig;
  private readonly leaseMs: number;

  constructor(
    private readonly store: ConsumerRetryStore,
    private readonly processor: DomainEventProcessor,
    private readonly dispatcher: DomainEventDispatcher,
    @Inject(METRICS) private readonly metrics: MetricsPort,
    private readonly cls: ClsService,
    config: ConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.ladder = retryLadderFrom(config);
    this.leaseMs = requireIntConfig(config, 'messaging.retry.leaseMs', 1);
    logger.setContext(LOG_CONTEXT);
  }

  // One row per lease: leasing the whole batch up front would let the tail's leases run out while the
  // head is still being worked, handing those rows to a second poller.
  async runOnce(batch: number, signal?: AbortSignal): Promise<RetryTickSummary> {
    const summary: RetryTickSummary = { leased: 0, processed: 0, rescheduled: 0, buried: 0, lost: 0 };
    while (summary.leased < batch && !signal?.aborted) {
      const row = await this.store.leaseOne(this.leaseMs);
      if (!row) break;
      summary.leased += 1;
      const outcome = await runInJobContext(this.cls, `consumer-retry:${row.eventType}`, () => this.attempt(row));
      summary[outcome] += 1;
    }
    return summary;
  }

  private async attempt(row: LeasedRetry): Promise<AttemptOutcome> {
    const policy = retryPolicyFor(row.eventType, this.ladder);
    // The lease charged an attempt the ladder no longer has: the last holder died inside it.
    if (row.attemptsMade > policy.attempts) return this.bury(row, 'attempts_exhausted');

    try {
      await this.processor.process(row.envelope, row.consumer);
    } catch (error) {
      if (error instanceof PermanentError) return this.bury(row, 'permanent', error);
      if (row.attemptsMade >= policy.attempts) return this.bury(row, 'attempts_exhausted', error);
      return this.reschedule(row, policy.delayAfter(row.attemptsMade), error);
    }
    return this.settled(await this.store.complete(row), row, 'processed');
  }

  private async reschedule(row: LeasedRetry, delayMs: number, error: unknown): Promise<AttemptOutcome> {
    const outcome = this.settled(await this.store.reschedule(row, delayMs, error), row, 'rescheduled');
    if (outcome === 'rescheduled') {
      this.metrics.recordConsumeRetry(this.dispatcher.label(row.eventType));
      this.logger.warn(
        { ...this.identify(row), err: rootCause(error), delayMs },
        'domain event retry failed, will retry',
      );
    }
    return outcome;
  }

  private async bury(row: LeasedRetry, reason: DeadLetterReason, error?: unknown): Promise<AttemptOutcome> {
    const outcome = this.settled(await this.store.bury(row, reason, error), row, 'buried');
    if (outcome === 'buried') {
      this.metrics.recordDeadLetter(this.dispatcher.label(row.eventType), reason);
      this.logger.error(
        { ...this.identify(row), err: error === undefined ? undefined : rootCause(error), reason },
        'domain event dead-lettered',
      );
    }
    return outcome;
  }

  private settled(won: boolean, row: LeasedRetry, outcome: AttemptOutcome): AttemptOutcome {
    if (won) return outcome;
    this.logger.warn(this.identify(row), 'retry lease expired before its result was written');
    return 'lost';
  }

  private identify(row: LeasedRetry) {
    return {
      consumer: row.consumer,
      eventType: row.eventType,
      messageId: row.messageId,
      attemptsMade: row.attemptsMade,
    };
  }
}
