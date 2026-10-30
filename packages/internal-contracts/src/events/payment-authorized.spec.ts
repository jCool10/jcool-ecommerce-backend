import { PAYMENT_AUTHORIZED_EVENT, isPaymentAuthorizedPayload, paymentAuthorizedPayload } from './payment-authorized';

const PAYLOAD = {
  paymentId: '6797560299127808',
  orderId: '6797560428102656',
  amountMinor: 150_000,
  currency: 'VND',
  authorizedAt: '2026-10-20T08:10:00.000Z',
};

describe('payment.authorized payload', () => {
  it('is named the way every job of it already in Redis is', () => {
    expect(PAYMENT_AUTHORIZED_EVENT).toBe('payment.authorized');
  });

  it('accepts what the producer writes', () => {
    const payload = paymentAuthorizedPayload({ ...PAYLOAD, authorizedAt: new Date(PAYLOAD.authorizedAt) });

    expect(payload).toEqual(PAYLOAD);
    expect(isPaymentAuthorizedPayload(payload)).toBe(true);
  });

  it('accepts a payload with fields it does not know', () => {
    expect(isPaymentAuthorizedPayload({ ...PAYLOAD, extra: 'ignored' })).toBe(true);
  });

  it.each(Object.keys(PAYLOAD))('refuses a payload without %s', (field) => {
    const { [field as keyof typeof PAYLOAD]: _dropped, ...rest } = PAYLOAD;

    expect(isPaymentAuthorizedPayload(rest)).toBe(false);
  });

  it.each([
    { paymentId: '' },
    { paymentId: 42 },
    { orderId: null },
    { amountMinor: '150000' },
    { amountMinor: 1.5 },
    { amountMinor: 0 },
    { amountMinor: Number.MAX_SAFE_INTEGER + 1 },
    { currency: '' },
    { currency: 'vnd' },
    { currency: 'VNDX' },
  ])('refuses %j', (override) => {
    expect(isPaymentAuthorizedPayload({ ...PAYLOAD, ...override })).toBe(false);
  });

  it.each([
    'yesterday',
    '2026-10-20',
    '2026-10-20 08:10:00',
    '2026-10-20T08:10:00+07:00',
    '2026-13-40T08:10:00.000Z',
    '',
  ])('refuses authorizedAt %j, which is not an ISO instant in UTC', (authorizedAt) => {
    expect(isPaymentAuthorizedPayload({ ...PAYLOAD, authorizedAt })).toBe(false);
  });

  it.each([null, undefined, [], 'payment.authorized'])('refuses %j as a payload', (payload) => {
    expect(isPaymentAuthorizedPayload(payload)).toBe(false);
  });
});
