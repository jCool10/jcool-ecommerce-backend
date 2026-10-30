import { Injectable } from '@nestjs/common';
import { isRoutableId } from '@jcool/id-codec';
import { isPaymentAuthorizedPayload } from '@jcool/internal-contracts/events/payment-authorized';
import { type DomainEventJob, PermanentError } from '@jcool/messaging';
import type { PaymentAuthorization } from '../../domain/checkout-saga';
import { ForwardPaymentAuthorizationUseCase } from '../../application/use-cases';

/** Runs before the inbox claim: a Temporal outage fails the delivery and the job retries on its ladder. */
@Injectable()
export class PaymentAuthorizedHandler {
  constructor(private readonly forwardAuthorization: ForwardPaymentAuthorizationUseCase) {}

  async forward(job: DomainEventJob): Promise<void> {
    const { payload } = job;
    // Another service writes this now, so the contract's guard decides the shape.
    if (!isPaymentAuthorizedPayload(payload) || !isRoutableId(payload.orderId)) {
      throw new PermanentError(`Unusable payment.authorized event ${job.outboxId}`);
    }
    const { orderId, paymentId, amountMinor, currency, authorizedAt } = payload;
    const authorization: PaymentAuthorization = { paymentId, amountMinor, currency, authorizedAt };
    await this.forwardAuthorization.execute(orderId, authorization);
  }
}
