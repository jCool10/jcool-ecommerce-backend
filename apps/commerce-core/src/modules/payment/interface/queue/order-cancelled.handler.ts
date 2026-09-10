import { Injectable } from '@nestjs/common';
import type { DrizzleTx } from '@shared/infrastructure/database';
import { PermanentError } from '@shared/messaging/errors';
import type { DomainEventJob } from '@shared/messaging/queue/domain-event.job';
import { ExpirePaymentSessionUseCase } from '../../application/use-cases';

/**
 * Separate from `OrderExpiredHandler`, which calls the same use case, because the trigger is what the
 * refund log line reports — and a cancel is a button pressed while a checkout page may be open, so
 * "the session just took the money" is everyday here rather than rare.
 */
@Injectable()
export class OrderCancelledHandler {
  constructor(private readonly expireSession: ExpirePaymentSessionUseCase) {}

  async close(job: DomainEventJob, tx: DrizzleTx): Promise<void> {
    const orderId = job.payload.orderId;
    // Permanent: the payload will be identical on every redelivery, and a guessed orderId would
    // expire the wrong buyer's session.
    if (typeof orderId !== 'string') {
      throw new PermanentError(`Unusable order cancellation event "${job.eventType}"`);
    }

    await this.expireSession.execute(orderId, tx, 'cancel');
  }
}
