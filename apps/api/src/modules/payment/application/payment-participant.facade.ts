import { Injectable } from '@nestjs/common';
import type {
  CancelOutcome,
  CaptureOutcome,
  OpenSessionInput,
  OpenSessionResult,
  PaymentParticipant,
} from './public/payment-participant.port';
import { CancelPaymentUseCase } from './use-cases/cancel-payment.use-case';
import { CapturePaymentUseCase } from './use-cases/capture-payment.use-case';
import { OpenPaymentSessionUseCase } from './use-cases/open-payment-session.use-case';

@Injectable()
export class PaymentParticipantFacade implements PaymentParticipant {
  constructor(
    private readonly openPaymentSession: OpenPaymentSessionUseCase,
    private readonly capturePayment: CapturePaymentUseCase,
    private readonly cancelPayment: CancelPaymentUseCase,
  ) {}

  openSession(input: OpenSessionInput): Promise<OpenSessionResult> {
    return this.openPaymentSession.execute(input);
  }

  capture(orderId: string): Promise<{ outcome: CaptureOutcome }> {
    return this.capturePayment.execute(orderId);
  }

  cancel(orderId: string): Promise<{ outcome: CancelOutcome }> {
    return this.cancelPayment.execute(orderId);
  }
}
