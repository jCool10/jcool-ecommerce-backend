import { describe, expect, it, vi } from 'vitest';
import Stripe from 'stripe';
import { StripeGatewayAdapter, type StripeGatewayOptions } from './stripe-gateway.adapter';
import { PaymentGatewayError } from '../../application/ports/payment-gateway.port';

const SECRET = 'whsec_test_secret_value_0000';

function adapter(): StripeGatewayAdapter {
  return new StripeGatewayAdapter({ webhookSecret: SECRET, toleranceSec: 300 });
}

// Live mode via an injected Stripe-shaped client: exercises the real branch with no key or network.
function liveAdapter(
  create: (...args: unknown[]) => unknown,
  overrides: Partial<StripeGatewayOptions> = {},
): StripeGatewayAdapter {
  const stripeClient = { checkout: { sessions: { create } } } as unknown as Pick<Stripe, 'checkout'>;
  return new StripeGatewayAdapter({
    webhookSecret: SECRET,
    toleranceSec: 300,
    successUrl: 'https://app.test/ok?session_id={CHECKOUT_SESSION_ID}',
    cancelUrl: 'https://app.test/cancel',
    stripeClient,
    ...overrides,
  });
}

// Live mode for the reconciliation calls, which read/close a session instead of creating one.
function statusAdapter(sessions: Record<string, unknown>): StripeGatewayAdapter {
  return new StripeGatewayAdapter({
    webhookSecret: SECRET,
    toleranceSec: 300,
    successUrl: 'https://app.test/ok',
    stripeClient: { checkout: { sessions } } as unknown as Pick<Stripe, 'checkout'>,
  });
}

function stripeError(statusCode: number, type: Stripe.StripeRawError['type'] = 'invalid_request_error'): unknown {
  return Stripe.errors.StripeError.generate({ statusCode, type, message: 'stripe says no' });
}

describe('StripeGatewayAdapter', () => {
  describe('construction fail-fast', () => {
    it('throws when the webhook secret is missing or blank', () => {
      for (const webhookSecret of [undefined, '   ']) {
        expect(() => new StripeGatewayAdapter({ webhookSecret, toleranceSec: 300 }), String(webhookSecret)).toThrow(
          /PAYMENT_WEBHOOK_SECRET is required/,
        );
      }
    });

    // A blank env var parses to NaN, which would silently switch replay defense off.
    it('throws when the tolerance window is NaN or negative', () => {
      for (const toleranceSec of [NaN, -1]) {
        expect(() => new StripeGatewayAdapter({ webhookSecret: SECRET, toleranceSec }), String(toleranceSec)).toThrow(
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
      const readBack = [['cs_live_1', undefined, { timeout: 5_000, maxNetworkRetries: 0 }]];
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
