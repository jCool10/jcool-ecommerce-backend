import { describe, expect, it, vi } from 'vitest';
import Stripe from 'stripe';
import { StripeGatewayAdapter, type StripeGatewayOptions } from './stripe-gateway.adapter';
import { PaymentGatewayError } from '../../application/ports/payment-gateway.port';

const SECRET = 'whsec_test_secret_value_0000';
const CAPTURE_TIMEOUT_MS = 10_000;
const BOUNDED = { timeout: CAPTURE_TIMEOUT_MS, maxNetworkRetries: 0 };

const BASE: StripeGatewayOptions = {
  webhookSecret: SECRET,
  toleranceSec: 300,
  sessionMinTtlSec: 30 * 60,
  sessionExpiryMarginSec: 120,
  captureTimeoutMs: CAPTURE_TIMEOUT_MS,
};

type StripeClient = NonNullable<StripeGatewayOptions['stripeClient']>;

function adapter(): StripeGatewayAdapter {
  return new StripeGatewayAdapter(BASE);
}

// Live mode via an injected Stripe-shaped client: exercises the real branch with no key or network.
function liveAdapter(
  create: (...args: unknown[]) => unknown,
  overrides: Partial<StripeGatewayOptions> = {},
): StripeGatewayAdapter {
  const stripeClient = { checkout: { sessions: { create } } } as unknown as StripeClient;
  return new StripeGatewayAdapter({
    ...BASE,
    successUrl: 'https://app.test/ok?session_id={CHECKOUT_SESSION_ID}',
    cancelUrl: 'https://app.test/cancel',
    stripeClient,
    ...overrides,
  });
}

// Live mode for the calls that read, close, capture or void instead of creating.
function statusAdapter(
  sessions: Record<string, unknown>,
  paymentIntents: Record<string, unknown> = {},
): StripeGatewayAdapter {
  return new StripeGatewayAdapter({
    ...BASE,
    successUrl: 'https://app.test/ok',
    stripeClient: { checkout: { sessions }, paymentIntents } as unknown as StripeClient,
  });
}

function stripeError(
  statusCode: number,
  type: Stripe.StripeRawError['type'] = 'invalid_request_error',
  code?: string,
): unknown {
  return Stripe.errors.StripeError.generate({ statusCode, type, code, message: 'stripe says no' });
}

describe('StripeGatewayAdapter', () => {
  describe('construction fail-fast', () => {
    it('throws when the webhook secret is missing or blank', () => {
      for (const webhookSecret of [undefined, '   ']) {
        expect(() => new StripeGatewayAdapter({ ...BASE, webhookSecret }), String(webhookSecret)).toThrow(
          /PAYMENT_WEBHOOK_SECRET is required/,
        );
      }
    });

    // A blank env var parses to NaN, which would silently switch replay defense off.
    it('throws when the tolerance window is NaN or negative', () => {
      for (const toleranceSec of [NaN, -1]) {
        expect(() => new StripeGatewayAdapter({ ...BASE, toleranceSec }), String(toleranceSec)).toThrow(
          /PAYMENT_WEBHOOK_TOLERANCE_SEC must be a non-negative number/,
        );
      }
    });
  });

  describe('createSession (live mode)', () => {
    it('creates a real Checkout Session and maps the order onto Stripe params', async () => {
      const create = vi
        .fn()
        .mockResolvedValue({ id: 'cs_test_live_123', url: 'https://checkout.stripe.com/c/pay/cs_test_live_123' });

      const session = await liveAdapter(create).createSession({
        orderId: 'ord-1',
        amountMinor: 150_000,
        currency: 'VND',
        idempotencyKey: 'idem-1',
      });

      expect(session).toEqual({
        providerSessionId: 'cs_test_live_123',
        redirectUrl: 'https://checkout.stripe.com/c/pay/cs_test_live_123',
      });
      const [params, options] = create.mock.calls[0] as [Stripe.Checkout.SessionCreateParams, Stripe.RequestOptions];
      expect(params).toMatchObject({
        mode: 'payment',
        success_url: 'https://app.test/ok?session_id={CHECKOUT_SESSION_ID}',
        cancel_url: 'https://app.test/cancel',
        client_reference_id: 'ord-1',
        metadata: { order_id: 'ord-1' },
      });
      // Currency lowercased for Stripe; the frozen total is one price_data line.
      expect(params.line_items?.[0]).toMatchObject({
        quantity: 1,
        price_data: { currency: 'vnd', unit_amount: 150_000, product_data: { name: 'Order ord-1' } },
      });
      expect(options).toEqual({ idempotencyKey: 'idem-1' });
    });

    // Anything this service fails to close stays payable until the gateway's own clock runs out, so
    // that clock is set just above the shortest Stripe accepts rather than its 24h default. Strictly
    // above: Stripe checks the value against its own clock, which our latency and skew cannot reach.
    it("sets the session lifetime past Stripe's 30-minute minimum rather than exactly at it", async () => {
      const create = vi.fn().mockResolvedValue({ id: 'cs_test_ttl', url: null });
      const before = Math.floor(Date.now() / 1000);

      await liveAdapter(create).createSession({ orderId: 'o', amountMinor: 1, currency: 'USD' });

      // The whole margin, not merely "more than the minimum": the adapter reads its own clock after
      // `before`, so a bare `>` would also pass on a crossed second with no margin at all.
      const [params] = create.mock.calls[0] as [Stripe.Checkout.SessionCreateParams];
      expect(params.expires_at).toBeGreaterThanOrEqual(before + 30 * 60 + 120);
      expect(params.expires_at).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 30 * 60 + 120);
      expect(params.payment_intent_data).toBeUndefined();
    });

    it('opens a manual-capture session that expires exactly when the caller says', async () => {
      const create = vi.fn().mockResolvedValue({ id: 'cs_test_manual', url: null });
      const expiresAt = new Date('2026-10-20T10:45:30.900Z');

      await liveAdapter(create).createSession({
        orderId: 'o',
        amountMinor: 1,
        currency: 'VND',
        captureMethod: 'manual',
        expiresAt,
      });

      const [params] = create.mock.calls[0] as [Stripe.Checkout.SessionCreateParams];
      expect(params.payment_intent_data).toEqual({ capture_method: 'manual' });
      expect(params.expires_at).toBe(Math.floor(expiresAt.getTime() / 1000));
    });

    it('wraps a provider failure in PaymentGatewayError so the caller can map it to 502', async () => {
      const create = vi.fn().mockRejectedValue(new Error('network down'));

      await expect(
        liveAdapter(create).createSession({ orderId: 'o', amountMinor: 1, currency: 'USD' }),
      ).rejects.toBeInstanceOf(PaymentGatewayError);
    });

    it('fail-fasts at construction when a live client is set but success_url is blank', () => {
      expect(() => liveAdapter(vi.fn(), { successUrl: '   ' })).toThrow(/STRIPE_SUCCESS_URL is required/);
    });
  });
});

describe('StripeGatewayAdapter reconciliation calls', () => {
  // The offline handle is fabricated and exists nowhere at Stripe, so nothing there was ever payable.
  it('reports UNKNOWN and closes as a no-op offline', async () => {
    await expect(adapter().getPaymentStatus('cs_test_anything')).resolves.toEqual({ status: 'UNKNOWN' });
    await expect(adapter().expireSession('cs_test_anything')).resolves.toBe('expired');
  });

  describe('getPaymentStatus', () => {
    it('maps the session payment_status and status onto a gateway status', async () => {
      const sessions = [
        ['paid', 'complete'],
        ['no_payment_required', 'complete'],
        ['unpaid', 'expired'],
        ['unpaid', 'open'],
        ['unpaid', 'complete'],
      ];

      const statuses = await Promise.all(
        sessions.map(async ([payment_status, status]) => {
          const retrieve = vi.fn().mockResolvedValue({ payment_status, status, payment_intent: null });
          return (await statusAdapter({ retrieve }).getPaymentStatus('cs_live_1')).status;
        }),
      );

      expect(statuses).toEqual(['PAID', 'PAID', 'FAILED', 'PENDING', 'PENDING']);
    });

    // The handle keeps a sweep-settled payment refundable, and the sweep settles only against a
    // charge that matches the payment row.
    it('carries the PaymentIntent handle, plain or expanded, and the charge the session holds', async () => {
      const paid = { payment_status: 'paid', status: 'complete', amount_total: 150_000, currency: 'vnd' };
      const probes = await Promise.all(
        ['pi_1', { id: 'pi_2' }].map((payment_intent) =>
          statusAdapter({ retrieve: vi.fn().mockResolvedValue({ ...paid, payment_intent }) }).getPaymentStatus(
            'cs_live_1',
          ),
        ),
      );

      expect(probes).toEqual([
        { status: 'PAID', intentId: 'pi_1', amountMinor: 150_000, currency: 'vnd' },
        { status: 'PAID', intentId: 'pi_2', amountMinor: 150_000, currency: 'vnd' },
      ]);
    });

    it('treats a handle Stripe does not recognise as UNKNOWN, so one bad row cannot stall the sweep', async () => {
      const retrieve = vi.fn().mockRejectedValue(stripeError(404));

      await expect(statusAdapter({ retrieve }).getPaymentStatus('cs_gone')).resolves.toEqual({ status: 'UNKNOWN' });
    });

    it('throws on any other provider fault, so an outage is never read as "not paid"', async () => {
      const retrieve = vi.fn().mockRejectedValue(stripeError(503, 'api_error'));

      await expect(statusAdapter({ retrieve }).getPaymentStatus('cs_live_1')).rejects.toBeInstanceOf(
        PaymentGatewayError,
      );
    });
  });

  describe('retrieveSession', () => {
    it('reports UNKNOWN and closes as a no-op offline', async () => {
      await expect(adapter().retrieveSession('cs_test_anything')).resolves.toEqual({ status: 'UNKNOWN' });
    });

    it("hands back the session's own redirect URL while it is still open", async () => {
      const retrieve = vi.fn().mockResolvedValue({
        payment_status: 'unpaid',
        status: 'open',
        url: 'https://checkout.stripe.com/c/pay/cs_live_1',
      });

      await expect(statusAdapter({ retrieve }).retrieveSession('cs_live_1')).resolves.toEqual({
        status: 'PENDING',
        redirectUrl: 'https://checkout.stripe.com/c/pay/cs_live_1',
      });
    });

    it('treats a handle Stripe does not recognise as UNKNOWN, so a repeat pay opens a fresh session', async () => {
      const retrieve = vi.fn().mockRejectedValue(stripeError(404));

      await expect(statusAdapter({ retrieve }).retrieveSession('cs_gone')).resolves.toEqual({ status: 'UNKNOWN' });
    });

    it('throws on any other provider fault, so an outage is never read as a dead session', async () => {
      const retrieve = vi.fn().mockRejectedValue(stripeError(503, 'api_error'));

      await expect(statusAdapter({ retrieve }).retrieveSession('cs_live_1')).rejects.toBeInstanceOf(
        PaymentGatewayError,
      );
    });
  });

  describe('expireSession', () => {
    it('bounds the call by the capture timeout and leaves retries to the caller', async () => {
      const expire = vi.fn().mockResolvedValue({ id: 'cs_live_1', status: 'expired' });

      await expect(statusAdapter({ expire }).expireSession('cs_live_1')).resolves.toBe('expired');
      expect(expire).toHaveBeenCalledWith('cs_live_1', undefined, BOUNDED);
    });

    it('accepts an unrecognised handle as already unpayable, without reading it back', async () => {
      const expire = vi.fn().mockRejectedValue(stripeError(404));
      const retrieve = vi.fn();

      await expect(statusAdapter({ expire, retrieve }).expireSession('cs_gone')).resolves.toBe('already_closed');
      expect(retrieve).not.toHaveBeenCalled();
    });

    // Stripe answers a completed session and a lapsed one with the same 400, and the two mean a
    // refund and a no-op. The read-back is the only thing that tells them apart.
    it('reads a refused session back to tell a completed one from a lapsed one', async () => {
      const outcomes = await Promise.all(
        (['complete', 'expired'] as const).map(async (status) => {
          const retrieve = vi.fn().mockResolvedValue({ id: 'cs_live_1', status });
          const expire = vi.fn().mockRejectedValue(stripeError(400));
          const outcome = await statusAdapter({ expire, retrieve }).expireSession('cs_live_1');
          return [outcome, retrieve.mock.calls];
        }),
      );

      // Bounded, because this runs inside the consumer's transaction.
      const readBack = [['cs_live_1', undefined, BOUNDED]];
      expect(outcomes).toEqual([
        ['already_completed', readBack],
        ['already_closed', readBack],
      ]);
    });

    // Refused while still payable is a reason we do not model. Swallowing it would leave a live page
    // in front of stock that has been released.
    it('throws when a refused session reads back as still open', async () => {
      const expire = vi.fn().mockRejectedValue(stripeError(400));
      const retrieve = vi.fn().mockResolvedValue({ id: 'cs_live_1', status: 'open' });

      await expect(statusAdapter({ expire, retrieve }).expireSession('cs_live_1')).rejects.toBeInstanceOf(
        PaymentGatewayError,
      );
    });

    it('treats a refused session that has since vanished as already unpayable', async () => {
      const expire = vi.fn().mockRejectedValue(stripeError(400));
      const retrieve = vi.fn().mockRejectedValue(stripeError(404));

      await expect(statusAdapter({ expire, retrieve }).expireSession('cs_live_1')).resolves.toBe('already_closed');
    });

    it('throws when the read-back itself fails, so an outage is never read as "already closed"', async () => {
      const expire = vi.fn().mockRejectedValue(stripeError(400));
      const retrieve = vi.fn().mockRejectedValue(stripeError(503, 'api_error'));

      await expect(statusAdapter({ expire, retrieve }).expireSession('cs_live_1')).rejects.toBeInstanceOf(
        PaymentGatewayError,
      );
    });

    // Not a refusal at all: a 5xx says nothing about the session, so it must not be classified.
    it('throws on a provider outage without reading the session back', async () => {
      const expire = vi.fn().mockRejectedValue(stripeError(503, 'api_error'));
      const retrieve = vi.fn();

      await expect(statusAdapter({ expire, retrieve }).expireSession('cs_live_1')).rejects.toBeInstanceOf(
        PaymentGatewayError,
      );
      expect(retrieve).not.toHaveBeenCalled();
    });
  });
});

describe('StripeGatewayAdapter participant calls', () => {
  const intent = (status: string, extra: Record<string, unknown> = {}) => ({ id: 'pi_1', status, ...extra });
  const unknownOutcomes: Array<[string, unknown]> = [
    ['a timeout', new Stripe.errors.StripeConnectionError({ message: 'Request aborted due to timeout' })],
    ['a request with the same key still in flight', stripeError(409, 'idempotency_error')],
    ['a rate limit', stripeError(429, 'invalid_request_error')],
    ['any other refusal', stripeError(400, 'invalid_request_error', 'parameter_invalid_integer')],
  ];

  // Offline must never invent a hold or a capture: either would move an order on money that does not exist.
  it('fails closed offline', async () => {
    await expect(adapter().retrieveAuthorization('cs_test_x')).resolves.toEqual({ sessionStatus: 'unknown' });
    await expect(adapter().captureIntent('pi_x', 'capture:1:0')).rejects.toBeInstanceOf(PaymentGatewayError);
    await expect(adapter().voidIntent('pi_x', 'void:1:0')).rejects.toBeInstanceOf(PaymentGatewayError);
  });

  describe('retrieveAuthorization', () => {
    it('reads the session with its PaymentIntent expanded, bounded and without SDK retries', async () => {
      const retrieve = vi.fn().mockResolvedValue({
        status: 'complete',
        url: null,
        payment_intent: intent('requires_capture', { amount_capturable: 150_000, currency: 'vnd' }),
      });

      await expect(statusAdapter({ retrieve }).retrieveAuthorization('cs_live_1')).resolves.toEqual({
        sessionStatus: 'complete',
        intentId: 'pi_1',
        intentStatus: 'requires_capture',
        amountCapturableMinor: 150_000,
        currency: 'vnd',
      });
      expect(retrieve).toHaveBeenCalledWith('cs_live_1', { expand: ['payment_intent'] }, BOUNDED);
    });

    it('maps every PaymentIntent status it acts on, and folds the rest into other', async () => {
      const statuses = [
        'requires_capture',
        'succeeded',
        'canceled',
        'processing',
        'requires_payment_method',
        'requires_action',
      ];

      const mapped = await Promise.all(
        statuses.map(async (status) => {
          const retrieve = vi.fn().mockResolvedValue({ status: 'complete', payment_intent: intent(status) });
          return (await statusAdapter({ retrieve }).retrieveAuthorization('cs_live_1')).intentStatus;
        }),
      );

      expect(mapped).toEqual([
        'requires_capture',
        'succeeded',
        'canceled',
        'processing',
        'requires_payment_method',
        'other',
      ]);
    });

    it('hands back the payment page of a session that is still open', async () => {
      const retrieve = vi
        .fn()
        .mockResolvedValue({ status: 'open', url: 'https://checkout.stripe.com/c/pay/cs_1', payment_intent: null });

      await expect(statusAdapter({ retrieve }).retrieveAuthorization('cs_live_1')).resolves.toEqual({
        sessionStatus: 'open',
        redirectUrl: 'https://checkout.stripe.com/c/pay/cs_1',
      });
    });

    it('reports a handle Stripe does not recognise as unknown and throws on an outage', async () => {
      const gone = vi.fn().mockRejectedValue(stripeError(404));
      const down = vi.fn().mockRejectedValue(stripeError(503, 'api_error'));

      await expect(statusAdapter({ retrieve: gone }).retrieveAuthorization('cs_x')).resolves.toEqual({
        sessionStatus: 'unknown',
      });
      await expect(statusAdapter({ retrieve: down }).retrieveAuthorization('cs_x')).rejects.toBeInstanceOf(
        PaymentGatewayError,
      );
    });
  });

  describe('captureIntent', () => {
    it('captures under the caller key, bounded and without SDK retries', async () => {
      const capture = vi.fn().mockResolvedValue(intent('succeeded'));

      await expect(statusAdapter({}, { capture }).captureIntent('pi_1', 'capture:7:0')).resolves.toEqual({
        kind: 'captured',
      });
      expect(capture).toHaveBeenCalledWith('pi_1', {}, { idempotencyKey: 'capture:7:0', ...BOUNDED });
    });

    // Stripe replays a stored 5xx for the same key, so only reading the intent says what happened.
    it.each([
      ['succeeded', { kind: 'captured' }],
      ['canceled', { kind: 'not_capturable', intentStatus: 'canceled' }],
      ['requires_payment_method', { kind: 'not_capturable', intentStatus: 'requires_payment_method' }],
    ])('reads the intent back after a 5xx: %s', async (status, expected) => {
      const capture = vi.fn().mockRejectedValue(stripeError(500, 'api_error'));
      const retrieve = vi.fn().mockResolvedValue(intent(status));

      await expect(statusAdapter({}, { capture, retrieve }).captureIntent('pi_1', 'k')).resolves.toEqual(expected);
      expect(retrieve).toHaveBeenCalledWith('pi_1', undefined, BOUNDED);
    });

    it('asks for a fresh key when the intent is still capturable after a 5xx', async () => {
      const capture = vi.fn().mockRejectedValue(stripeError(500, 'api_error'));
      const retrieve = vi.fn().mockResolvedValue(intent('requires_capture'));

      await expect(statusAdapter({}, { capture, retrieve }).captureIntent('pi_1', 'k')).rejects.toMatchObject({
        name: 'PaymentGatewayError',
        retryWithFreshKey: true,
      });
    });

    it('reads the intent back when Stripe refuses it in an unexpected state', async () => {
      const capture = vi
        .fn()
        .mockRejectedValue(stripeError(400, 'invalid_request_error', 'payment_intent_unexpected_state'));
      const retrieve = vi.fn().mockResolvedValue(intent('canceled'));

      await expect(statusAdapter({}, { capture, retrieve }).captureIntent('pi_1', 'k')).resolves.toEqual({
        kind: 'not_capturable',
        intentStatus: 'canceled',
      });
    });

    it.each(unknownOutcomes)(
      'throws on %s, keeping the key and never calling it not capturable',
      async (_label, error) => {
        const capture = vi.fn().mockRejectedValue(error);
        const retrieve = vi.fn();

        await expect(statusAdapter({}, { capture, retrieve }).captureIntent('pi_1', 'k')).rejects.toMatchObject({
          name: 'PaymentGatewayError',
          retryWithFreshKey: false,
        });
        expect(retrieve).not.toHaveBeenCalled();
      },
    );

    it('keeps the key when the read-back after a 5xx fails too', async () => {
      const capture = vi.fn().mockRejectedValue(stripeError(502, 'api_error'));
      const retrieve = vi.fn().mockRejectedValue(stripeError(503, 'api_error'));

      await expect(statusAdapter({}, { capture, retrieve }).captureIntent('pi_1', 'k')).rejects.toMatchObject({
        retryWithFreshKey: false,
      });
    });
  });

  describe('voidIntent', () => {
    it('cancels the intent under the caller key, bounded and without SDK retries', async () => {
      const cancel = vi.fn().mockResolvedValue(intent('canceled'));

      await expect(statusAdapter({}, { cancel }).voidIntent('pi_1', 'void:7:0')).resolves.toBe('voided');
      expect(cancel).toHaveBeenCalledWith('pi_1', {}, { idempotencyKey: 'void:7:0', ...BOUNDED });
    });

    it.each([
      [stripeError(500, 'api_error'), 'canceled', 'already_canceled'],
      [stripeError(500, 'api_error'), 'succeeded', 'already_captured'],
      [stripeError(400, 'invalid_request_error', 'payment_intent_unexpected_state'), 'canceled', 'already_canceled'],
      [stripeError(400, 'invalid_request_error', 'payment_intent_unexpected_state'), 'succeeded', 'already_captured'],
    ])('reads the intent back after %o: %s → %s', async (error, status, expected) => {
      const cancel = vi.fn().mockRejectedValue(error);
      const retrieve = vi.fn().mockResolvedValue(intent(status));

      await expect(statusAdapter({}, { cancel, retrieve }).voidIntent('pi_1', 'k')).resolves.toBe(expected);
    });

    it('asks for a fresh key when the hold is still there after a 5xx', async () => {
      const cancel = vi.fn().mockRejectedValue(stripeError(500, 'api_error'));
      const retrieve = vi.fn().mockResolvedValue(intent('requires_capture'));

      await expect(statusAdapter({}, { cancel, retrieve }).voidIntent('pi_1', 'k')).rejects.toMatchObject({
        retryWithFreshKey: true,
      });
    });

    it.each(unknownOutcomes)('throws on %s and keeps the key', async (_label, error) => {
      const cancel = vi.fn().mockRejectedValue(error);
      const retrieve = vi.fn();

      await expect(statusAdapter({}, { cancel, retrieve }).voidIntent('pi_1', 'k')).rejects.toMatchObject({
        retryWithFreshKey: false,
      });
      expect(retrieve).not.toHaveBeenCalled();
    });
  });
});
