import { Injectable } from '@nestjs/common';
import { isRoutableId } from '@jcool/id-codec';
import { PermanentError } from '@shared/messaging/errors';
import type { DomainEventJob } from '@shared/messaging/queue/domain-event.job';
import type { PaymentAuthorization } from '../../domain/checkout-saga';
import { ForwardPaymentAuthorizationUseCase } from '../../application/use-cases';

const nonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/** Runs before the inbox claim: a Temporal outage fails the delivery and the job retries on its ladder. */
@Injectable()
export class PaymentAuthorizedHandler {
  constructor(private readonly forwardAuthorization: ForwardPaymentAuthorizationUseCase) {}

  async forward(job: DomainEventJob): Promise<void> {
    const { orderId, paymentId, amountMinor, currency, authorizedAt } = job.payload;
    if (
      !isRoutableId(orderId) ||
      !nonEmptyString(paymentId) ||
      !Number.isSafeInteger(amountMinor) ||
      !nonEmptyString(currency) ||
      !nonEmptyString(authorizedAt) ||
      Number.isNaN(Date.parse(authorizedAt))
    ) {
      throw new PermanentError(`Unusable payment.authorized event ${job.outboxId}`);
    }
    const authorization: PaymentAuthorization = {
      paymentId,
      amountMinor: amountMinor as number,
      currency,
      authorizedAt,
    };
    await this.forwardAuthorization.execute(orderId, authorization);
  }
}
