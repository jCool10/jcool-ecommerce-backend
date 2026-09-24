import { describe, expect, it } from 'vitest';
import { Payment } from '../../domain/payment.entity';
import { PaymentStatus } from '../../domain/payment-status';
import { chargeMatchesPayment } from './charge-matches-payment';

function payment(): Payment {
  return Payment.rehydrate({
    id: 'p1',
    orderId: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001',
    provider: 'stripe',
    providerSessionId: 'cs_1',
    providerIntentId: null,
    amountMinor: 150_000,
    currency: 'VND',
    status: PaymentStatus.PENDING,
  });
}

describe('chargeMatchesPayment', () => {
  // Providers report ISO-4217 lowercase and the payment row stores it upper; without folding, every
  // real settlement would be refused.
  it('matches the provider lowercase form of the recorded currency', () => {
    expect(chargeMatchesPayment(payment(), { amountMinor: 150_000, currency: 'vnd' })).toBe(true);
  });

  it('refuses a charge whose amount or currency differs or is missing', () => {
    const charges = [
      { amountMinor: 149_000, currency: 'vnd' },
      { amountMinor: 150_000, currency: 'usd' },
      { amountMinor: 150_000 },
      { currency: 'vnd' },
      {},
    ];

    expect(charges.map((charge) => chargeMatchesPayment(payment(), charge))).toEqual(charges.map(() => false));
  });
});
