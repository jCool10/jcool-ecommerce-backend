import { ApiProperty } from '@nestjs/swagger';
import type { CreatePaymentSessionResult } from '../../application/use-cases';

export class CreatePaymentSessionResponseDto {
  @ApiProperty({ format: 'uuid', description: 'Id of the PENDING Payment just created' })
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

  static from(result: CreatePaymentSessionResult): CreatePaymentSessionResponseDto {
    return {
      paymentId: result.paymentId,
      providerSessionId: result.providerSessionId,
      redirectUrl: result.redirectUrl,
      clientSecret: result.clientSecret,
    };
  }
}
