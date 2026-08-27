import { Injectable } from '@nestjs/common';
import type { DrizzleTx } from '@shared/infrastructure/database';
import { PermanentError } from '@shared/messaging/errors';
import type { DomainEventJob } from '@shared/messaging/queue/domain-event.job';
import { ExpirePaymentSessionUseCase } from '../../application/use-cases';

/**
 * The money half of a TTL expiry: Order announces that it gave up on an order, Payment closes the
 * session that could still charge for it.
 *
 * Order stays the saga's coordinator — it never tells Payment to expire anything, it only publishes
 * what it decided — so the reaction lives here. Via the outbox rather than a direct call because the
 * gateway is exactly what is unreachable when these events pile up: the queue's retry and
 * dead-letter path is what carries the attempt until the gateway answers.
 */
@Injectable()
export class OrderExpiredHandler {
  constructor(private readonly expireSession: ExpirePaymentSessionUseCase) {}

  async close(job: DomainEventJob, tx: DrizzleTx): Promise<void> {
    const orderId = job.payload.orderId;
    // Permanent: the payload will be identical on every redelivery, and a guessed orderId would
    // expire the wrong buyer's session.
    if (typeof orderId !== 'string') {
      throw new PermanentError(`Unusable order expiry event "${job.eventType}"`);
    }

    await this.expireSession.execute(orderId, tx);
  }
}
