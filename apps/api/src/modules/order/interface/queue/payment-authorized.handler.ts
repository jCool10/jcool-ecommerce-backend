import { Inject, Injectable } from '@nestjs/common';
import { ID_GENERATOR, mintOne, type IdGeneratorPort } from '@shared/identity/id-generator.port';
import { PermanentError } from '@shared/messaging/errors';
import type { TransactionalStep } from '@shared/messaging/handlers/domain-event.dispatcher';
import type { DomainEventJob } from '@shared/messaging/queue/domain-event.job';
import {
  OnPaymentAuthorizedUseCase,
  type PaymentAuthorized,
} from '../../application/use-cases/on-payment-authorized.use-case';

/**
 * The only path from an authorization to the saga. The effect it hands back submits a kick and
 * returns at once: commit and capture can take tens of seconds, far too long to hold a queue slot.
 */
@Injectable()
export class PaymentAuthorizedHandler {
  constructor(
    private readonly onPaymentAuthorized: OnPaymentAuthorizedUseCase,
    @Inject(ID_GENERATOR) private readonly ids: IdGeneratorPort,
  ) {}

  /** The event id is minted before the consumer's transaction, so no row lock waits on the id service. */
  async prepare(job: DomainEventJob): Promise<TransactionalStep> {
    const authorized = readAuthorized(job);
    const eventId = await mintOne(this.ids);
    return async (tx) => {
      const afterCommit = await this.onPaymentAuthorized.execute(authorized, tx, eventId);
      return afterCommit ? () => Promise.resolve(afterCommit()) : undefined;
    };
  }
}

// Permanent, not retryable: the same payload comes back on every redelivery, and a guessed field
// could confirm the wrong order or compare against the wrong amount.
function readAuthorized({ eventType, payload }: DomainEventJob): PaymentAuthorized {
  const { orderId, amountMinor, currency } = payload;
  if (typeof orderId !== 'string' || !Number.isSafeInteger(amountMinor) || typeof currency !== 'string') {
    throw new PermanentError(`Unusable payment authorization event "${eventType}"`);
  }
  return { orderId, amountMinor: amountMinor as number, currency };
}
