import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { DomainEventJob } from '../queue/domain-event.job';

const LOG_CONTEXT = 'OrderEventsHandler';

/**
 * Order events, consumed for audit only — on purpose, not as a placeholder.
 *
 * Every effect these events could trigger has already been applied by the transaction that emitted
 * them: checkout holds the stock, finalize commits or releases it. A consumer that "reacted" to the
 * event would apply that effect twice. What is genuinely missing is the outward fan-out — mail, read
 * models, other contexts — and none of it belongs here: those effects live in their own contexts and
 * must be reached through their published language, not from shared infrastructure.
 *
 * So the useful work today is the audit trail: proof the event crossed the queue boundary, on the
 * producer's trace.
 */
@Injectable()
export class OrderEventsHandler {
  constructor(private readonly logger: PinoLogger) {}

  record(job: DomainEventJob): Promise<void> {
    this.logger.info(
      {
        context: LOG_CONTEXT,
        eventType: job.eventType,
        orderId: job.aggregateId,
        messageId: job.outboxId,
        occurredAt: job.occurredAt,
      },
      'order event consumed',
    );
    // Nothing to await yet. The Promise return type is the contract a real effect will need, since
    // it has to run inside the consumer's transaction alongside the inbox claim.
    return Promise.resolve();
  }
}
