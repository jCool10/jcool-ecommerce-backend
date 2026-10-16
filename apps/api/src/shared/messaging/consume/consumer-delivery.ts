import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import { isRoutableId } from '@jcool/id-codec';
import { METRICS, type MetricsPort } from '@jcool/metrics-port';
import { PermanentError } from '../errors';
import { DomainEventDispatcher, UNREGISTERED_EVENT_LABEL } from '../handlers/domain-event.dispatcher';
import { envelopeFields, type DomainEventJob } from '../queue/domain-event.job';
import { DomainEventProcessor, type AppliedResult } from '../queue/domain-event.processor';
import { ConsumerRetryStore, type ParkVerdict } from '../retry/consumer-retry.store';
import { isDataException, rootCause } from '../retry/retry-error';
import { retryLadderFrom, retryPolicyFor, type RetryLadderConfig } from '../retry/retry-policy';

const LOG_CONTEXT = 'ConsumerDelivery';

export type DeliveryOutcome = AppliedResult | 'retrying' | 'dead';

/**
 * The first delivery of a message, whatever transport brought it. A failure is parked as a retry row
 * and the transport is told the delivery succeeded; only a park that cannot be written goes back to
 * the transport to retry.
 */
@Injectable()
export class ConsumerDelivery {
  private readonly ladder: RetryLadderConfig;

  constructor(
    private readonly processor: DomainEventProcessor,
    private readonly store: ConsumerRetryStore,
    private readonly dispatcher: DomainEventDispatcher,
    @Inject(METRICS) private readonly metrics: MetricsPort,
    config: ConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.ladder = retryLadderFrom(config);
    logger.setContext(LOG_CONTEXT);
  }

  async deliver(consumer: string, job: DomainEventJob): Promise<DeliveryOutcome> {
    try {
      return await this.processor.process(job, consumer);
    } catch (error) {
      return this.park(consumer, job, error);
    }
  }

  /** Never throws: it runs in a transport listener with nobody left to hand an error to. */
  async recordTransportExhausted(
    consumer: string,
    job: DomainEventJob | undefined,
    attemptsMade: number,
    error: Error,
  ): Promise<void> {
    const messageId = job?.outboxId;
    this.logger.error(
      { err: rootCause(error), consumer, eventType: job?.eventType, messageId, attemptsMade },
      'transport gave up on a delivery that could not be parked',
    );
    this.metrics.recordDeadLetter(this.label(job), 'attempts_exhausted');
    if (!job || !isRoutableId(messageId)) return;

    try {
      await this.store.insertDead(consumer, job, attemptsMade, error);
    } catch (caught) {
      this.logger.error({ err: rootCause(caught), consumer, messageId }, 'failed to file the dead letter');
    }
  }

  private async park(consumer: string, job: DomainEventJob, error: unknown): Promise<DeliveryOutcome> {
    // Producer-side bug only: the relay never publishes without an outbox id, so there is nothing to
    // key a row on and the log plus the dead-letter alert are all that can be left behind.
    if (!isRoutableId(job?.outboxId)) {
      this.logger.error(
        { err: rootCause(error), consumer, fields: envelopeFields(job) },
        'dropped a delivery with no routable message id',
      );
      this.metrics.recordDeadLetter(UNREGISTERED_EVENT_LABEL, 'permanent');
      return 'dead';
    }

    const metricLabel = this.label(job);
    const verdict = this.verdictFor(job.eventType, error);
    const context = { consumer, eventType: job.eventType, messageId: job.outboxId };
    let parked: boolean;
    try {
      parked = await this.store.park(consumer, job, error, verdict);
    } catch (parkError) {
      const root = rootCause(parkError);
      if (isDataException(parkError)) {
        this.logger.error({ ...context, err: root }, 'failed delivery cannot be stored, dropped as dead');
        this.metrics.recordDeadLetter(metricLabel, 'permanent');
        return 'dead';
      }
      this.logger.error(
        { ...context, err: root, cause: rootCause(error) },
        'failed to park a failed delivery, handing it back to the transport',
      );
      // BullMQ keeps the thrown error's message and stack on the job for days.
      throw root;
    }

    if (!parked) {
      // A redelivery of a message that already has a row: that row's ladder, or its dead state, stands.
      this.logger.warn({ ...context, err: rootCause(error) }, 'domain event consume failed, already parked');
      return verdict.status === 'pending' ? 'retrying' : 'dead';
    }
    if (verdict.status === 'pending') {
      this.metrics.recordConsumeRetry(metricLabel);
      this.logger.warn({ ...context, err: rootCause(error) }, 'domain event consume failed, will retry');
      return 'retrying';
    }
    this.metrics.recordDeadLetter(metricLabel, verdict.reason);
    this.logger.error({ ...context, err: rootCause(error), reason: verdict.reason }, 'domain event dead-lettered');
    return 'dead';
  }

  private verdictFor(eventType: string, error: unknown): ParkVerdict {
    if (error instanceof PermanentError) return { status: 'dead', reason: 'permanent' };
    const policy = retryPolicyFor(eventType, this.ladder);
    return policy.attempts > 1
      ? { status: 'pending', delayMs: policy.delayAfter(1) }
      : { status: 'dead', reason: 'attempts_exhausted' };
  }

  private label(job: DomainEventJob | undefined): string {
    return this.dispatcher.label(typeof job?.eventType === 'string' ? job.eventType : '');
  }
}
