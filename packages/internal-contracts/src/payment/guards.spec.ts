import {
  cancelOutcomeOf,
  captureOutcomeOf,
  isCancelResponse,
  isCaptureResponse,
  isOpenSessionResponse,
  isPaymentStatusResponse,
  isProviderUnavailable,
  isRefundResponse,
  paymentStatusesOf,
  refundOutcomeOf,
  sessionOutcomeOf,
} from './guards';
import {
  CANCEL_OUTCOME_STATUS,
  CAPTURE_OUTCOME_STATUS,
  REFUND_OUTCOME_STATUS,
  SESSION_OUTCOME_STATUS,
  paymentRoutes,
} from './routes';
import {
  CANCEL_OUTCOMES,
  CAPTURE_OUTCOMES,
  PAYMENT_ORDER_STATUSES,
  PROVIDER_UNAVAILABLE,
  REFUND_OUTCOMES,
  type PaymentStatusEntry,
} from './types';

const OPENED = { outcome: 'OPENED', paymentId: '7', providerSessionId: 'cs_1', redirectUrl: 'https://pay.test/cs_1' };
const NOTHING: PaymentStatusEntry = {
  header: null,
  authorizedPaymentId: null,
  hasAuthorizedAttempt: false,
  hasSucceededAttempt: false,
};
const HELD: PaymentStatusEntry = {
  header: 'AUTHORIZED',
  authorizedPaymentId: '7',
  hasAuthorizedAttempt: true,
  hasSucceededAttempt: false,
};

describe('payment response guards', () => {
  it('accepts an opened session with or without the optional links', () => {
    expect(isOpenSessionResponse(OPENED)).toBe(true);
    expect(isOpenSessionResponse({ ...OPENED, clientSecret: 'cs_1_secret' })).toBe(true);
    expect(isOpenSessionResponse({ outcome: 'OPENED', paymentId: '7', providerSessionId: 'cs_1' })).toBe(true);
    expect(isOpenSessionResponse({ outcome: 'CLOSED' })).toBe(true);
  });

  it.each([
    { outcome: 'OPENED', providerSessionId: 'cs_1' },
    { ...OPENED, paymentId: '' },
    { ...OPENED, paymentId: 7 },
    { ...OPENED, providerSessionId: undefined },
    { ...OPENED, redirectUrl: null },
    { ...OPENED, clientSecret: 1 },
    { outcome: 'opened' },
    null,
    [],
  ])('refuses %j as a session answer', (body) => {
    expect(isOpenSessionResponse(body)).toBe(false);
  });

  it.each(CAPTURE_OUTCOMES)('accepts a capture answered %s', (outcome) => {
    expect(isCaptureResponse({ outcome })).toBe(true);
  });

  it.each(CANCEL_OUTCOMES)('accepts a cancel answered %s', (outcome) => {
    expect(isCancelResponse({ outcome })).toBe(true);
  });

  it.each([undefined, {}, { outcome: 'APPLIED' }, { outcome: 'CANCELLED' }])(
    'refuses %j as a capture answer',
    (body) => {
      expect(isCaptureResponse(body)).toBe(false);
    },
  );

  it.each([undefined, { outcome: 'CAPTURED' }, { outcome: null }])('refuses %j as a cancel answer', (body) => {
    expect(isCancelResponse(body)).toBe(false);
  });

  it.each(REFUND_OUTCOMES)('accepts a refund answered %s', (outcome) => {
    expect(isRefundResponse({ outcome })).toBe(true);
  });

  it.each([undefined, {}, { outcome: 'CAPTURED' }, { outcome: 'REFUND_FAILED', reason: 7 }])(
    'refuses %j as a refund answer',
    (body) => {
      expect(isRefundResponse(body)).toBe(false);
    },
  );

  it('accepts statuses that carry every field', () => {
    expect(isPaymentStatusResponse({ statuses: {} })).toBe(true);
    expect(isPaymentStatusResponse({ statuses: { '1': NOTHING, '2': HELD } })).toBe(true);
  });

  it('accepts the refund headers, appended after FENCED in the enum order', () => {
    expect(PAYMENT_ORDER_STATUSES.slice(-4)).toEqual(['FENCED', 'REFUNDING', 'REFUNDED', 'REFUND_FAILED']);
    for (const header of ['REFUNDING', 'REFUNDED', 'REFUND_FAILED']) {
      expect(isPaymentStatusResponse({ statuses: { '1': { ...HELD, header } } })).toBe(true);
    }
  });

  it.each([
    {},
    { statuses: [] },
    { statuses: { '1': null } },
    { statuses: { '1': { ...HELD, header: 'HELD' } } },
    { statuses: { '1': { ...HELD, authorizedPaymentId: 7 } } },
    { statuses: { '1': { header: 'OPEN', hasAuthorizedAttempt: false, hasSucceededAttempt: false } } },
    { statuses: { '1': { ...HELD, hasSucceededAttempt: 'no' } } },
  ])('refuses %j as a status answer', (body) => {
    expect(isPaymentStatusResponse(body)).toBe(false);
  });
});

describe('payment outcome and status code', () => {
  it('maps a session to 409 only when nothing opened', () => {
    expect(SESSION_OUTCOME_STATUS).toEqual({ OPENED: 200, CLOSED: 409 });
  });

  it('maps capture and cancel to 409 only on their refusals', () => {
    expect(CAPTURE_OUTCOME_STATUS).toEqual({ CAPTURED: 200, IDEMPOTENT: 200, NOT_CAPTURABLE: 409, CONFLICT: 409 });
    expect(CANCEL_OUTCOME_STATUS).toEqual({ CANCELLED: 200, FENCED: 200, IDEMPOTENT: 200, CAPTURED_CONFLICT: 409 });
  });

  it('reads an answer only when the status code agrees with it', () => {
    expect(sessionOutcomeOf(200, OPENED)).toEqual(OPENED);
    expect(sessionOutcomeOf(409, { outcome: 'CLOSED' })).toEqual({ outcome: 'CLOSED' });
    expect(sessionOutcomeOf(409, OPENED)).toBeUndefined();
    expect(sessionOutcomeOf(200, { outcome: 'CLOSED' })).toBeUndefined();
    expect(sessionOutcomeOf(409, { message: 'Conflict' })).toBeUndefined();

    expect(captureOutcomeOf(200, { outcome: 'IDEMPOTENT' })).toBe('IDEMPOTENT');
    expect(captureOutcomeOf(409, { outcome: 'NOT_CAPTURABLE' })).toBe('NOT_CAPTURABLE');
    expect(captureOutcomeOf(200, { outcome: 'CONFLICT' })).toBeUndefined();

    expect(cancelOutcomeOf(200, { outcome: 'FENCED' })).toBe('FENCED');
    expect(cancelOutcomeOf(409, { outcome: 'CAPTURED_CONFLICT' })).toBe('CAPTURED_CONFLICT');
    expect(cancelOutcomeOf(409, { outcome: 'CANCELLED' })).toBeUndefined();
  });

  it('maps a refund to 202 while Stripe holds it and to 409 on its refusals', () => {
    expect(REFUND_OUTCOME_STATUS).toEqual({
      REFUNDED: 200,
      IDEMPOTENT: 200,
      PENDING: 202,
      REFUND_FAILED: 409,
      NOT_REFUNDABLE: 409,
    });
  });

  it.each([
    [200, 'REFUNDED'],
    [200, 'IDEMPOTENT'],
    [202, 'PENDING'],
    [409, 'REFUND_FAILED'],
    [409, 'NOT_REFUNDABLE'],
  ] as const)('reads a refund answered %i %s', (status, outcome) => {
    expect(refundOutcomeOf(status, { outcome })).toEqual({ outcome });
  });

  it('reads a refund only when the status code agrees with it, keeping the failure reason', () => {
    expect(refundOutcomeOf(409, { outcome: 'REFUND_FAILED', reason: 'expired_or_canceled_card', extra: 1 })).toEqual({
      outcome: 'REFUND_FAILED',
      reason: 'expired_or_canceled_card',
    });
    expect(refundOutcomeOf(200, { outcome: 'PENDING' })).toBeUndefined();
    expect(refundOutcomeOf(202, { outcome: 'REFUNDED' })).toBeUndefined();
    expect(refundOutcomeOf(200, { outcome: 'NOT_REFUNDABLE' })).toBeUndefined();
    expect(refundOutcomeOf(409, { outcome: 'CANCELLED' })).toBeUndefined();
    expect(refundOutcomeOf(409, { message: 'Conflict' })).toBeUndefined();
  });

  it('keeps only the fields of the contract from an opened session', () => {
    expect(sessionOutcomeOf(200, { ...OPENED, internal: 'x' })).toEqual(OPENED);
  });

  it('carries the client secret of an embedded session, with no key for the redirect it left out', () => {
    const { redirectUrl: _, ...embedded } = { ...OPENED, clientSecret: 'cs_1_secret' };

    expect(sessionOutcomeOf(200, embedded)).toStrictEqual(embedded);
    expect(sessionOutcomeOf(200, embedded)).not.toHaveProperty('redirectUrl');
  });

  it('reads a provider outage only from a 503 that carries its code', () => {
    const down = { statusCode: 503, code: PROVIDER_UNAVAILABLE, message: 'Service unavailable' };

    expect(isProviderUnavailable(503, down)).toBe(true);
    expect(isProviderUnavailable(503, { statusCode: 503, message: 'Service unavailable' })).toBe(false);
    expect(isProviderUnavailable(503, { code: 'LOCK_BUDGET_EXHAUSTED' })).toBe(false);
    expect(isProviderUnavailable(503, null)).toBe(false);
    expect(isProviderUnavailable(500, down)).toBe(false);
    expect(isProviderUnavailable(409, down)).toBe(false);
  });

  it('reads statuses only when every id asked for is answered', () => {
    expect(paymentStatusesOf({ statuses: { '1': NOTHING, '2': HELD } }, ['1', '2'])).toEqual(
      new Map([
        ['1', NOTHING],
        ['2', HELD],
      ]),
    );
    expect(paymentStatusesOf({ statuses: { '1': HELD } }, ['1', '2'])).toBeUndefined();
    expect(
      paymentStatusesOf({ statuses: { '1': { ...HELD, authorizedPaymentId: undefined } } }, ['1']),
    ).toBeUndefined();
    expect(paymentStatusesOf({ statuses: { '1': HELD, '9': NOTHING } }, ['1'])).toEqual(new Map([['1', HELD]]));
  });
});

describe('paymentRoutes', () => {
  it('puts the order id in the path, encoded', () => {
    expect(paymentRoutes.session('42')).toBe('/internal/v1/payments/42/session');
    expect(paymentRoutes.capture('42')).toBe('/internal/v1/payments/42/capture');
    expect(paymentRoutes.cancel('a/b')).toBe('/internal/v1/payments/a%2Fb/cancel');
    expect(paymentRoutes.refund('42')).toBe('/internal/v1/payments/42/refund');
    expect(paymentRoutes.status).toBe('/internal/v1/payments/status');
  });
});
