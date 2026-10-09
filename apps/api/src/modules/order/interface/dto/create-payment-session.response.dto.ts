import { ApiProperty } from '@nestjs/swagger';
import type { PaymentSession } from '../../application/ports/payment-participant.port';

export class CreatePaymentSessionResponseDto {
  @ApiProperty({ example: '137465797020397179', description: 'Id of the PENDING Payment just created' })
  paymentId!: string;

  @ApiProperty({ example: 'cs_test_9f8e...', description: 'Gateway session handle (Stripe: cs_...)' })
  providerSessionId!: string;

  @ApiProperty({
    required: false,
    example: 'https://checkout.stripe.test/pay/cs_test_9f8e',
    description: 'Hosted checkout URL (or a VietQR payload for domestic gateways) to redirect the buyer to',
  })
  redirectUrl?: string;

  @ApiProperty({
    required: false,
    description: 'PaymentIntent client_secret, when the gateway flow uses one instead of a redirect',
  })
  clientSecret?: string;

  static from(session: PaymentSession): CreatePaymentSessionResponseDto {
    return {
      paymentId: session.paymentId,
      providerSessionId: session.providerSessionId,
      redirectUrl: session.redirectUrl,
      clientSecret: session.clientSecret,
    };
  }
}
