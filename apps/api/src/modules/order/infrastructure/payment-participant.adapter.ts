import { Inject, Injectable } from '@nestjs/common';
import {
  PAYMENT_PARTICIPANT,
  PaymentProviderUnavailableError,
  type PaymentParticipant,
} from '@modules/payment/application/public/payment-participant.port';
import {
  PaymentUnavailableError,
  type OpenSessionAnswer,
  type PaymentTccPort,
} from '../application/ports/payment-participant.port';

@Injectable()
export class PaymentParticipantAdapter implements PaymentTccPort {
  constructor(@Inject(PAYMENT_PARTICIPANT) private readonly payment: PaymentParticipant) {}

  async openSession(input: {
    orderId: string;
    amountMinor: number;
    currency: string;
    expiresAt: Date;
  }): Promise<OpenSessionAnswer> {
    let result;
    try {
      result = await this.payment.openSession(input);
    } catch (error) {
      if (error instanceof PaymentProviderUnavailableError) throw new PaymentUnavailableError({ cause: error });
      throw error;
    }
    if (result.outcome === 'CLOSED') return { outcome: 'CLOSED' };
    const { outcome: _, ...session } = result;
    return { outcome: 'OPENED', session };
  }

  async capture(orderId: string): Promise<'CAPTURED' | 'NOT_CAPTURABLE'> {
    return (await this.payment.capture(orderId)).outcome;
  }

  async cancel(orderId: string): Promise<'CANCELLED' | 'FENCED' | 'CAPTURED_CONFLICT'> {
    return (await this.payment.cancel(orderId)).outcome;
  }
}
