import { Inject, Injectable } from '@nestjs/common';
import {
  PAYMENT_PARTICIPANT,
  PaymentGatewayError,
  type PaymentParticipant,
} from '@modules/payment/application/public/payment-participant.port';
import {
  PaymentProviderUnavailableError,
  type OrderPaymentParticipantPort,
  type OrderPaymentStatus,
  type PaymentCancelOutcome,
  type PaymentCaptureOutcome,
  type PaymentSessionInput,
  type PaymentSessionResult,
} from '../application/ports/order-payment-participant.port';

// In-process until payment leaves as its own service. The abort signal is not forwarded: the Stripe
// SDK takes none, and the participant bounds each gateway call itself.
@Injectable()
export class OrderPaymentParticipantAdapter implements OrderPaymentParticipantPort {
  constructor(@Inject(PAYMENT_PARTICIPANT) private readonly participant: PaymentParticipant) {}

  async openSession(input: PaymentSessionInput): Promise<PaymentSessionResult> {
    try {
      return await this.participant.openSession(input);
    } catch (error) {
      if (error instanceof PaymentGatewayError) throw new PaymentProviderUnavailableError({ cause: error });
      throw error;
    }
  }

  capture(orderId: string): Promise<PaymentCaptureOutcome> {
    return this.participant.capture({ orderId });
  }

  cancel(orderId: string): Promise<PaymentCancelOutcome> {
    return this.participant.cancel({ orderId });
  }

  statusOf(orderIds: string[]): Promise<Map<string, OrderPaymentStatus>> {
    return this.participant.statusOf(orderIds);
  }
}
