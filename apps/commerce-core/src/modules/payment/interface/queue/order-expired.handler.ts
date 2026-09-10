import { Injectable } from '@nestjs/common';
import type { DrizzleTx } from '@shared/infrastructure/database';
import { PermanentError } from '@shared/messaging/errors';
import type { DomainEventJob } from '@shared/messaging/queue/domain-event.job';
import { ExpirePaymentSessionUseCase } from '../../application/use-cases';

/**
 * Order publishes what it decided and never tells Payment to expire anything, so the reaction lives
 * here. Via the outbox rather than a direct call because the gateway is exactly what is unreachable
 * when these events pile up, and the queue's retry path is what carries the attempt until it answers.
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

    await this.expireSession.execute(orderId, tx, 'ttl');
  }
}
