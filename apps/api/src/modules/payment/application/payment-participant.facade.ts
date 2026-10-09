import { Injectable } from '@nestjs/common';
import { PaymentGatewayError } from './ports/payment-gateway.port';
import {
  PaymentProviderUnavailableError,
  type CancelOutcome,
  type CaptureOutcome,
  type OpenSessionInput,
  type OpenSessionResult,
  type PaymentParticipant,
} from './public/payment-participant.port';
import { CancelPaymentUseCase } from './use-cases/cancel-payment.use-case';
import { CapturePaymentUseCase } from './use-cases/capture-payment.use-case';
import { ConcurrentSessionOpenError, OpenPaymentSessionUseCase } from './use-cases/open-payment-session.use-case';

@Injectable()
export class PaymentParticipantFacade implements PaymentParticipant {
  constructor(
    private readonly openPaymentSession: OpenPaymentSessionUseCase,
    private readonly capturePayment: CapturePaymentUseCase,
    private readonly cancelPayment: CancelPaymentUseCase,
  ) {}

  async openSession(input: OpenSessionInput): Promise<OpenSessionResult> {
    try {
      return await this.openOnce(input);
    } catch (error) {
      // The loser of two concurrent opens closed its own session; a second pass reuses the winner's.
      if (error instanceof ConcurrentSessionOpenError) return this.openOnce(input);
      throw error;
    }
  }

  capture(orderId: string): Promise<{ outcome: CaptureOutcome }> {
    return this.capturePayment.execute(orderId);
  }

  cancel(orderId: string): Promise<{ outcome: CancelOutcome }> {
    return this.cancelPayment.execute(orderId);
  }

  private async openOnce(input: OpenSessionInput): Promise<OpenSessionResult> {
    try {
      return await this.openPaymentSession.execute(input);
    } catch (error) {
      if (error instanceof PaymentGatewayError) throw new PaymentProviderUnavailableError({ cause: error });
      throw error;
    }
  }
}
