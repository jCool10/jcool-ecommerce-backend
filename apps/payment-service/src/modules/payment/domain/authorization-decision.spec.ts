import { describe, expect, it } from 'vitest';
import { decideAuthorization, type AuthorizationFacts } from './authorization-decision';
import { PaymentOrderStatus } from './payment-order-status';
import { PaymentStatus } from './payment-status';

const AMOUNT = { amountMinor: 150_000, currency: 'VND' };

function facts(overrides: {
  payment?: Partial<AuthorizationFacts['payment']>;
  header?: Partial<AuthorizationFacts['header']>;
  charge?: Partial<AuthorizationFacts['charge']>;
}): AuthorizationFacts {
  return {
    payment: { status: PaymentStatus.PENDING, ...AMOUNT, ...overrides.payment },
    header: { status: PaymentOrderStatus.OPEN, ...AMOUNT, authorizedAt: null, ...overrides.header },
    charge: { amountMinor: AMOUNT.amountMinor, currency: 'vnd', ...overrides.charge },
  };
}

describe('decideAuthorization', () => {
  it('records a matching hold on the open attempt', () => {
    expect(decideAuthorization(facts({}))).toBe('RECORD');
  });

  it('records a hold that lands after the header was cancelled, so the orchestrator can void it', () => {
    expect(decideAuthorization(facts({ header: { status: PaymentOrderStatus.CANCELLED } }))).toBe('RECORD_LATE');
  });

  it.each([PaymentStatus.AUTHORIZED, PaymentStatus.SUCCEEDED, PaymentStatus.VOIDED])(
    'treats a payment already %s as recorded',
    (status) => {
      expect(decideAuthorization(facts({ payment: { status } }))).toBe('ALREADY_RECORDED');
    },
  );

  it.each([PaymentStatus.EXPIRED, PaymentStatus.FAILED])('calls a hold on a retired %s attempt stray', (status) => {
    expect(decideAuthorization(facts({ payment: { status } }))).toBe('STRAY');
  });

  it('calls a hold stray once the order already recorded one', () => {
    expect(decideAuthorization(facts({ header: { authorizedAt: new Date() } }))).toBe('STRAY');
  });

  it.each([PaymentOrderStatus.AUTHORIZED, PaymentOrderStatus.CAPTURED])(
    'calls a hold stray under a header already %s',
    (status) => {
      expect(decideAuthorization(facts({ header: { status } }))).toBe('STRAY');
    },
  );

  it('ranks a retired attempt above a wrong amount', () => {
    expect(decideAuthorization(facts({ payment: { status: PaymentStatus.EXPIRED }, charge: { amountMinor: 1 } }))).toBe(
      'STRAY',
    );
  });

  it.each([
    ['a different amount', { charge: { amountMinor: 149_999 } }],
    ['a different currency', { charge: { currency: 'usd' } }],
    ['an attempt priced differently from its header', { payment: { amountMinor: 1 } }],
    [
      'a fenced header that never carried an amount',
      { header: { status: PaymentOrderStatus.FENCED, amountMinor: null, currency: null } },
    ],
  ] as const)('refuses %s', (_label, overrides) => {
    expect(decideAuthorization(facts(overrides))).toBe('AMOUNT_MISMATCH');
  });
});
