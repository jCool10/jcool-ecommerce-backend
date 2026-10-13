import { Injectable } from '@nestjs/common';
import { PermanentError } from '@shared/messaging/errors';
import type { DomainEventJob } from '@shared/messaging/queue/domain-event.job';
import {
  OnPaymentAuthorizedUseCase,
  type PaymentAuthorized,
} from '../../application/use-cases/on-payment-authorized.use-case';

/** The only path from an authorization to the saga: a signal, which returns once Temporal has it. */
@Injectable()
export class PaymentAuthorizedHandler {
  constructor(private readonly onPaymentAuthorized: OnPaymentAuthorizedUseCase) {}

  async apply(job: DomainEventJob): Promise<void> {
    await this.onPaymentAuthorized.execute(readAuthorized(job));
  }
}

// Permanent, not retryable: the same payload comes back on every redelivery, and a guessed field
// could confirm the wrong order or compare against the wrong amount.
function readAuthorized({ eventType, payload }: DomainEventJob): PaymentAuthorized {
  const { paymentId, orderId, amountMinor, currency, authorizedAt } = payload;
  const authorizedAtMs = typeof authorizedAt === 'string' ? Date.parse(authorizedAt) : Number.NaN;
  if (
    typeof paymentId !== 'string' ||
    typeof orderId !== 'string' ||
    !Number.isSafeInteger(amountMinor) ||
    typeof currency !== 'string' ||
    Number.isNaN(authorizedAtMs)
  ) {
    throw new PermanentError(`Unusable payment authorization event "${eventType}"`);
  }
  return { paymentId, orderId, amountMinor: amountMinor as number, currency, authorizedAt: new Date(authorizedAtMs) };
}
