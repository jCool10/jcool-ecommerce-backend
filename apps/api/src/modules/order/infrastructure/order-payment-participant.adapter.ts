import { Inject, Injectable } from '@nestjs/common';
import {
  PAYMENT_PARTICIPANT,
  type PaymentParticipant,
} from '@modules/payment/application/public/payment-participant.port';
import type {
  OrderPaymentParticipantPort,
  OrderPaymentStatus,
  PaymentCancelOutcome,
  PaymentCaptureOutcome,
  PaymentSessionInput,
  PaymentSessionResult,
} from '../application/ports/order-payment-participant.port';

// In-process until payment leaves as its own service. The abort signal is not forwarded: the Stripe
// SDK takes none, and the participant bounds each gateway call itself.
@Injectable()
export class OrderPaymentParticipantAdapter implements OrderPaymentParticipantPort {
  constructor(@Inject(PAYMENT_PARTICIPANT) private readonly participant: PaymentParticipant) {}

  openSession(input: PaymentSessionInput): Promise<PaymentSessionResult> {
    return this.participant.openSession(input);
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
