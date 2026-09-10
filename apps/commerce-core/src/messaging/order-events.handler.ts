import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { DomainEventJob } from '@shared/messaging/queue/domain-event.job';

const LOG_CONTEXT = 'OrderEventsHandler';

/**
 * Audit only, on purpose — not a placeholder. Every effect these events could trigger was already
 * applied by the transaction that emitted them (checkout holds the stock, finalize commits or
 * releases it), so a consumer that "reacted" would apply it twice.
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
    // Nothing to await yet; the Promise is the contract a real effect will need to run inside the
    // consumer's transaction alongside the inbox claim.
    return Promise.resolve();
  }
}
