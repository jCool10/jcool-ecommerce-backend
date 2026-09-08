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
  // Providers report ISO-4217 lowercase and the payment row stores it upper, so the everyday match
  // is the case-folded one; without folding, every real settlement would be refused.
  it('matches the provider lowercase form of the recorded currency', () => {
    expect(chargeMatchesPayment(payment(), { amountMinor: 150_000, currency: 'vnd' })).toBe(true);
  });

  it.each([
    ['a different amount', { amountMinor: 149_000, currency: 'vnd' }],
    ['a different currency', { amountMinor: 150_000, currency: 'usd' }],
    ['a missing currency', { amountMinor: 150_000 }],
    ['a missing amount', { currency: 'vnd' }],
    ['nothing at all', {}],
  ])('refuses %s', (_case, charge) => {
    expect(chargeMatchesPayment(payment(), charge)).toBe(false);
  });
});
