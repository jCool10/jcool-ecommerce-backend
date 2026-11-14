import { v7 as uuidv7 } from 'uuid';
import { vi } from 'vitest';
import type { PaymentGatewayPort } from '../application/ports/payment-gateway.port';
import { FakeStripeRefunds, type FakeCharge } from './fake-stripe-refunds';
import { fakePaymentGateway } from './payment-port.doubles';

/**
 * Captured charges and Stripe's refunds of them behind the gateway port, so the refund use-case specs
 * drive the refund model the e2e fake gateway uses without importing an adapter.
 */
export function fakeRefundGateway() {
  const charges = new Map<string, FakeCharge>();
  const refunds = new FakeStripeRefunds((intentId) => charges.get(intentId));
  const refundIntent = vi.fn<PaymentGatewayPort['refundIntent']>((input, key) => refunds.create(input, key));
  const retrieveRefund = vi.fn<PaymentGatewayPort['retrieveRefund']>((refundId) => refunds.retrieve(refundId));
  return {
    port: fakePaymentGateway({ refundIntent, retrieveRefund }),
    refunds,
    refundIntent,
    retrieveRefund,
    /** A charge Stripe captured in full; returns its PaymentIntent id. */
    capture(charge: { amountMinor: number; currency: string }): string {
      const intentId = `pi_fake_${uuidv7().replace(/-/g, '')}`;
      charges.set(intentId, {
        captured: true,
        amountMinor: charge.amountMinor,
        currency: charge.currency.toLowerCase(),
      });
      return intentId;
    },
  };
}
