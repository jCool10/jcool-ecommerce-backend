import { describe, expect, it, vi } from 'vitest';
import Stripe from 'stripe';
import { StripeGatewayAdapter, type StripeClient, type StripeGatewayOptions } from './stripe-gateway.adapter';
import { PaymentGatewayError } from '../../application/ports/payment-gateway.port';

const SECRET = 'whsec_test_secret_value_0000';
const SESSION_FLOOR_SEC = 1_860;
const CAPTURE_TIMEOUT_MS = 7_000;
// Every request a cancel or capture makes: one bounded attempt, because retrying is the saga's job.
const BOUNDED = { timeout: CAPTURE_TIMEOUT_MS, maxNetworkRetries: 0 };

const OPTIONS: StripeGatewayOptions = {
  webhookSecret: SECRET,
  toleranceSec: 300,
  sessionFloorSec: SESSION_FLOOR_SEC,
  captureTimeoutMs: CAPTURE_TIMEOUT_MS,
};

function adapter(): StripeGatewayAdapter {
  return new StripeGatewayAdapter(OPTIONS);
}

// Live mode via an injected Stripe-shaped client: exercises the real branch with no key or network.
function liveAdapter(
  create: (...args: unknown[]) => unknown,
  overrides: Partial<StripeGatewayOptions> = {},
): StripeGatewayAdapter {
  return new StripeGatewayAdapter({
    ...OPTIONS,
    successUrl: 'https://app.test/ok?session_id={CHECKOUT_SESSION_ID}',
    cancelUrl: 'https://app.test/cancel',
    stripeClient: { checkout: { sessions: { create } } } as unknown as StripeClient,
    ...overrides,
  });
}

// Live mode for the reconciliation calls, which read/close a session instead of creating one.
function statusAdapter(sessions: Record<string, unknown>): StripeGatewayAdapter {
  return new StripeGatewayAdapter({
    ...OPTIONS,
    successUrl: 'https://app.test/ok',
    stripeClient: { checkout: { sessions } } as unknown as StripeClient,
  });
}

function intentAdapter(paymentIntents: Record<string, unknown>): StripeGatewayAdapter {
  return new StripeGatewayAdapter({
    ...OPTIONS,
    successUrl: 'https://app.test/ok',
    stripeClient: { checkout: { sessions: {} }, paymentIntents } as unknown as StripeClient,
  });
}

function stripeError(
  statusCode: number,
  type: Stripe.StripeRawError['type'] = 'invalid_request_error',
  code?: string,
): unknown {
  return Stripe.errors.StripeError.generate({ statusCode, type, code, message: 'stripe says no' });
}

const unexpectedState = () => stripeError(400, 'invalid_request_error', 'payment_intent_unexpected_state');
const timedOut = () =>
  new Stripe.errors.StripeConnectionError({ message: 'Request aborted due to timeout being reached' });
const intent = (status: string) => ({ id: 'pi_1', status });

describe('StripeGatewayAdapter', () => {
  describe('construction fail-fast', () => {
    it('throws when the webhook secret is missing or blank', () => {
      for (const webhookSecret of [undefined, '   ']) {
        expect(() => new StripeGatewayAdapter({ ...OPTIONS, webhookSecret }), String(webhookSecret)).toThrow(
          /PAYMENT_WEBHOOK_SECRET is required/,
        );
      }
    });

    // A blank env var parses to NaN, which would silently switch replay defense off.
    it('throws when the tolerance window is NaN or negative', () => {
      for (const toleranceSec of [NaN, -1]) {
        expect(() => new StripeGatewayAdapter({ ...OPTIONS, toleranceSec }), String(toleranceSec)).toThrow(
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
      expect(params.payment_intent_data).toBeUndefined();
      // Currency lowercased for Stripe; the frozen total is one price_data line.
      expect(params.line_items?.[0]).toMatchObject({
        quantity: 1,
        price_data: { currency: 'vnd', unit_amount: 150_000, product_data: { name: 'Order ord-1' } },
      });
      expect(options).toEqual({ idempotencyKey: 'idem-1' });
    });

    // Anything this service fails to close stays payable until the gateway's own clock runs out, so
    // that clock is set at the configured floor rather than Stripe's 24h default.
    it("sets the session lifetime past Stripe's 30-minute minimum rather than exactly at it", async () => {
      const create = vi.fn().mockResolvedValue({ id: 'cs_test_ttl', url: null });
      const before = Math.floor(Date.now() / 1000);

      await liveAdapter(create).createSession({ orderId: 'o', amountMinor: 1, currency: 'USD' });

      // The whole floor, not merely "more than the minimum": the adapter reads its own clock after
      // `before`, so a bare `>` would also pass on a crossed second with no margin at all.
      const [params] = create.mock.calls[0] as [Stripe.Checkout.SessionCreateParams];
      expect(params.expires_at).toBeGreaterThanOrEqual(before + SESSION_FLOOR_SEC);
      expect(params.expires_at).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + SESSION_FLOOR_SEC);
    });

    it('opens a manual-capture session that dies at the deadline the caller gave', async () => {
      const create = vi.fn().mockResolvedValue({ id: 'cs_test_manual', url: 'https://checkout.stripe.com/m' });
      const expiresAt = new Date('2026-10-06T10:45:30.900Z');

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
    it('sends one bounded attempt, since a cancel waits on it', async () => {
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

describe('StripeGatewayAdapter manual capture', () => {
  // Production ran this branch before it had a key; a fabricated "captured" there would settle an
  // order no money stands behind.
  describe('offline', () => {
    it('never reports an authorization and refuses to move money', async () => {
      await expect(adapter().retrieveAuthorization('cs_test_anything')).resolves.toEqual({ sessionStatus: 'unknown' });
      await expect(adapter().capture('pi_1', 'capture:p1:0')).rejects.toBeInstanceOf(PaymentGatewayError);
      await expect(adapter().void('pi_1', 'void:p1:0')).rejects.toBeInstanceOf(PaymentGatewayError);
    });
  });

  describe('retrieveAuthorization', () => {
    it('expands the PaymentIntent in one bounded read and reports the hold it carries', async () => {
      const retrieve = vi.fn().mockResolvedValue({
        status: 'complete',
        payment_intent: { id: 'pi_1', status: 'requires_capture', amount_capturable: 150_000, currency: 'vnd' },
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

    it('maps every intent status, folding the ones a hold never passes through into other', async () => {
      const raw = [
        'requires_capture',
        'succeeded',
        'canceled',
        'processing',
        'requires_payment_method',
        'requires_action',
        'requires_confirmation',
      ];

      const mapped = await Promise.all(
        raw.map(async (status) => {
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
        'other',
      ]);
    });

    it('reports a session with no intent yet by its own status alone', async () => {
      const retrieve = vi.fn().mockResolvedValue({ status: 'open', payment_intent: null });

      await expect(statusAdapter({ retrieve }).retrieveAuthorization('cs_live_1')).resolves.toEqual({
        sessionStatus: 'open',
      });
    });

    it('reports an unrecognised handle as unknown and throws on an outage', async () => {
      const gone = vi.fn().mockRejectedValue(stripeError(404));
      const down = vi.fn().mockRejectedValue(stripeError(503, 'api_error'));

      await expect(statusAdapter({ retrieve: gone }).retrieveAuthorization('cs_gone')).resolves.toEqual({
        sessionStatus: 'unknown',
      });
      await expect(statusAdapter({ retrieve: down }).retrieveAuthorization('cs_live_1')).rejects.toBeInstanceOf(
        PaymentGatewayError,
      );
    });
  });

  describe('capture', () => {
    it('captures under the given key in one bounded attempt', async () => {
      const capture = vi.fn().mockResolvedValue(intent('succeeded'));

      await expect(intentAdapter({ capture }).capture('pi_1', 'capture:p1:0')).resolves.toEqual({ kind: 'captured' });
      expect(capture).toHaveBeenCalledWith('pi_1', undefined, { idempotencyKey: 'capture:p1:0', ...BOUNDED });
    });

    it('reads a state refusal back: already captured is done, a dead hold is not capturable', async () => {
      const outcomes = await Promise.all(
        ['succeeded', 'canceled'].map(async (status) => {
          const capture = vi.fn().mockRejectedValue(unexpectedState());
          const retrieve = vi.fn().mockResolvedValue(intent(status));
          const outcome = await intentAdapter({ capture, retrieve }).capture('pi_1', 'capture:p1:0');
          expect(retrieve).toHaveBeenCalledWith('pi_1', undefined, BOUNDED);
          return outcome;
        }),
      );

      expect(outcomes).toEqual([{ kind: 'captured' }, { kind: 'not_capturable', intentStatus: 'canceled' }]);
    });

    // Stripe stores the 5xx under the key, so resending it learns nothing; the intent does.
    it('reads the intent back after a 5xx within the same call', async () => {
      const outcomes = await Promise.all(
        ['succeeded', 'canceled', 'requires_payment_method'].map((status) => {
          const capture = vi.fn().mockRejectedValue(stripeError(500, 'api_error'));
          const retrieve = vi.fn().mockResolvedValue(intent(status));
          return intentAdapter({ capture, retrieve }).capture('pi_1', 'capture:p1:0');
        }),
      );

      expect(outcomes).toEqual([
        { kind: 'captured' },
        { kind: 'not_capturable', intentStatus: 'canceled' },
        { kind: 'not_capturable', intentStatus: 'requires_payment_method' },
      ]);
    });

    it('asks for a fresh key when a 5xx left the hold still capturable', async () => {
      const capture = vi.fn().mockRejectedValue(stripeError(500, 'api_error'));
      const retrieve = vi.fn().mockResolvedValue(intent('requires_capture'));

      const error = await intentAdapter({ capture, retrieve })
        .capture('pi_1', 'capture:p1:0')
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(PaymentGatewayError);
      expect((error as PaymentGatewayError).retryWithFreshKey).toBe(true);
    });

    // A 409 means the same key is still running; reading it as "not capturable" would fail an order
    // whose first capture then succeeds.
    it('throws every other fault as an unknown outcome, keeping the key and never reading back', async () => {
      const faults = [
        timedOut(),
        new Stripe.errors.StripeConnectionError({ message: 'ECONNRESET' }),
        stripeError(409, 'idempotency_error'),
        stripeError(429, 'rate_limit_error'),
        stripeError(402, 'card_error'),
        stripeError(400),
      ];

      for (const fault of faults) {
        const capture = vi.fn().mockRejectedValue(fault);
        const retrieve = vi.fn();

        const error = await intentAdapter({ capture, retrieve })
          .capture('pi_1', 'capture:p1:0')
          .catch((e: unknown) => e);

        expect(error).toBeInstanceOf(PaymentGatewayError);
        expect((error as PaymentGatewayError).retryWithFreshKey).toBe(false);
        expect(retrieve).not.toHaveBeenCalled();
      }
    });

    it('throws when the read-back itself fails', async () => {
      const capture = vi.fn().mockRejectedValue(stripeError(500, 'api_error'));
      const retrieve = vi.fn().mockRejectedValue(timedOut());

      const error = await intentAdapter({ capture, retrieve })
        .capture('pi_1', 'capture:p1:0')
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(PaymentGatewayError);
      expect((error as PaymentGatewayError).retryWithFreshKey).toBe(false);
    });
  });

  describe('void', () => {
    it('cancels the intent under the given key in one bounded attempt', async () => {
      const cancel = vi.fn().mockResolvedValue(intent('canceled'));

      await expect(intentAdapter({ cancel }).void('pi_1', 'void:p1:0')).resolves.toBe('voided');
      expect(cancel).toHaveBeenCalledWith('pi_1', undefined, { idempotencyKey: 'void:p1:0', ...BOUNDED });
    });

    it('reads the intent back after a state refusal or a 5xx', async () => {
      const cases = [
        [unexpectedState(), 'canceled'],
        [unexpectedState(), 'succeeded'],
        [stripeError(500, 'api_error'), 'canceled'],
        [stripeError(502, 'api_error'), 'succeeded'],
      ] as const;

      const outcomes = await Promise.all(
        cases.map(([fault, status]) => {
          const cancel = vi.fn().mockRejectedValue(fault);
          const retrieve = vi.fn().mockResolvedValue(intent(status));
          return intentAdapter({ cancel, retrieve }).void('pi_1', 'void:p1:0');
        }),
      );

      expect(outcomes).toEqual(['already_canceled', 'already_captured', 'already_canceled', 'already_captured']);
    });

    it('asks for a fresh key when a 5xx left the hold in place', async () => {
      const cancel = vi.fn().mockRejectedValue(stripeError(500, 'api_error'));
      const retrieve = vi.fn().mockResolvedValue(intent('requires_capture'));

      const error = await intentAdapter({ cancel, retrieve })
        .void('pi_1', 'void:p1:0')
        .catch((e: unknown) => e);

      expect((error as PaymentGatewayError).retryWithFreshKey).toBe(true);
    });

    it('throws an in-flight key or a timeout as an unknown outcome without reading back', async () => {
      for (const fault of [timedOut(), stripeError(409, 'idempotency_error')]) {
        const cancel = vi.fn().mockRejectedValue(fault);
        const retrieve = vi.fn();

        const error = await intentAdapter({ cancel, retrieve })
          .void('pi_1', 'void:p1:0')
          .catch((e: unknown) => e);

        expect(error).toBeInstanceOf(PaymentGatewayError);
        expect((error as PaymentGatewayError).retryWithFreshKey).toBe(false);
        expect(retrieve).not.toHaveBeenCalled();
      }
    });
  });
});
