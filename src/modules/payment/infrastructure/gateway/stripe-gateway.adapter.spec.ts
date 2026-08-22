import { describe, expect, it, vi } from 'vitest';
import Stripe from 'stripe';
import { StripeGatewayAdapter, type StripeGatewayOptions } from './stripe-gateway.adapter';
import { signStripeStyle } from './hmac-signature';
import { PaymentGatewayError } from '../../application/ports/payment-gateway.port';

const SECRET = 'whsec_test_secret_value_0000';

function adapter(): StripeGatewayAdapter {
  return new StripeGatewayAdapter({ webhookSecret: SECRET, toleranceSec: 300 });
}

// Live mode via an injected Stripe-shaped client — exercises the real branch with no key or network.
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
    it('throws when the webhook secret is missing', () => {
      expect(() => new StripeGatewayAdapter({ webhookSecret: undefined, toleranceSec: 300 })).toThrow(
        /PAYMENT_WEBHOOK_SECRET is required/,
      );
    });

    it('throws when the webhook secret is blank', () => {
      expect(() => new StripeGatewayAdapter({ webhookSecret: '   ', toleranceSec: 300 })).toThrow(
        /PAYMENT_WEBHOOK_SECRET is required/,
      );
    });

    it('throws when the tolerance window is NaN (blank env) so replay defense is never silently off', () => {
      expect(() => new StripeGatewayAdapter({ webhookSecret: SECRET, toleranceSec: NaN })).toThrow(
        /PAYMENT_WEBHOOK_TOLERANCE_SEC must be a non-negative number/,
      );
    });

    it('throws when the tolerance window is negative', () => {
      expect(() => new StripeGatewayAdapter({ webhookSecret: SECRET, toleranceSec: -1 })).toThrow(
        /PAYMENT_WEBHOOK_TOLERANCE_SEC must be a non-negative number/,
      );
    });
  });

  describe('createSession', () => {
    it('returns a stripe-style session handle and redirect url', async () => {
      const session = await adapter().createSession({ orderId: 'o1', amountMinor: 1500, currency: 'USD' });
      expect(session.providerSessionId).toMatch(/^cs_test_[0-9a-f]+$/);
      expect(session.redirectUrl).toContain(session.providerSessionId);
    });

    it('returns a distinct handle per call', async () => {
      const a = await adapter().createSession({ orderId: 'o1', amountMinor: 1500, currency: 'USD' });
      const b = await adapter().createSession({ orderId: 'o1', amountMinor: 1500, currency: 'USD' });
      expect(a.providerSessionId).not.toBe(b.providerSessionId);
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

    it('maps a null hosted url to an undefined redirectUrl', async () => {
      const create = vi.fn().mockResolvedValue({ id: 'cs_test_x', url: null });
      const session = await liveAdapter(create).createSession({ orderId: 'o', amountMinor: 1, currency: 'USD' });
      expect(session).toEqual({ providerSessionId: 'cs_test_x', redirectUrl: undefined });
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

  describe('verifyAndParseEvent', () => {
    const nowSec = Math.floor(Date.now() / 1000);

    function signedBody(tsSec: number) {
      const raw = Buffer.from(JSON.stringify({ id: 'evt_abc', type: 'payment_intent.succeeded' }));
      return { raw, header: signStripeStyle(SECRET, tsSec, raw) };
    }

    it('accepts a validly signed, in-window event', () => {
      const { raw, header } = signedBody(nowSec);
      const result = adapter().verifyAndParseEvent(raw, { 'stripe-signature': header });
      expect(result).toMatchObject({ kind: 'valid', providerEventId: 'evt_abc', type: 'payment_intent.succeeded' });
    });

    it('rejects a forged signature', () => {
      const { raw } = signedBody(nowSec);
      const result = adapter().verifyAndParseEvent(raw, { 'stripe-signature': `t=${nowSec},v1=${'0'.repeat(64)}` });
      expect(result).toEqual({ kind: 'invalid_signature' });
    });

    it('rejects an expired (replayed) event', () => {
      const { raw, header } = signedBody(nowSec - 301);
      const result = adapter().verifyAndParseEvent(raw, { 'stripe-signature': header });
      expect(result).toEqual({ kind: 'expired_timestamp' });
    });
  });
});

describe('StripeGatewayAdapter reconciliation calls', () => {
  describe('getPaymentStatus', () => {
    it('reports UNKNOWN offline, because the fabricated handle exists nowhere at Stripe', async () => {
      await expect(adapter().getPaymentStatus('cs_test_anything')).resolves.toEqual({ status: 'UNKNOWN' });
    });

    it.each([
      ['paid', 'complete', 'PAID'],
      ['no_payment_required', 'complete', 'PAID'],
      ['unpaid', 'expired', 'FAILED'],
      ['unpaid', 'open', 'PENDING'],
      ['unpaid', 'complete', 'PENDING'],
    ])('maps payment_status=%s status=%s to %s', async (payment_status, status, expected) => {
      const retrieve = vi.fn().mockResolvedValue({ payment_status, status, payment_intent: null });

      await expect(statusAdapter({ retrieve }).getPaymentStatus('cs_live_1')).resolves.toMatchObject({
        status: expected,
      });
      expect(retrieve).toHaveBeenCalledWith('cs_live_1');
    });

    it('carries the PaymentIntent handle so a sweep-settled payment stays refundable', async () => {
      const retrieve = vi
        .fn()
        .mockResolvedValue({ payment_status: 'paid', status: 'complete', payment_intent: 'pi_1' });

      await expect(statusAdapter({ retrieve }).getPaymentStatus('cs_live_1')).resolves.toEqual({
        status: 'PAID',
        intentId: 'pi_1',
      });
    });

    it('reads an expanded PaymentIntent object as the same handle', async () => {
      const retrieve = vi
        .fn()
        .mockResolvedValue({ payment_status: 'paid', status: 'complete', payment_intent: { id: 'pi_2' } });

      await expect(statusAdapter({ retrieve }).getPaymentStatus('cs_live_1')).resolves.toMatchObject({
        intentId: 'pi_2',
      });
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

  describe('expireSession', () => {
    it('is a no-op offline, where no session was ever payable', async () => {
      await expect(adapter().expireSession('cs_test_anything')).resolves.toBeUndefined();
    });

    it('closes the session at Stripe', async () => {
      const expire = vi.fn().mockResolvedValue({ id: 'cs_live_1', status: 'expired' });

      await expect(statusAdapter({ expire }).expireSession('cs_live_1')).resolves.toBeUndefined();
      expect(expire).toHaveBeenCalledWith('cs_live_1');
    });

    it('accepts an unrecognised handle as already unpayable', async () => {
      const expire = vi.fn().mockRejectedValue(stripeError(404));

      await expect(statusAdapter({ expire }).expireSession('cs_gone')).resolves.toBeUndefined();
    });

    it('throws when Stripe refuses, because the page may still take money', async () => {
      const expire = vi.fn().mockRejectedValue(stripeError(400));

      await expect(statusAdapter({ expire }).expireSession('cs_live_1')).rejects.toBeInstanceOf(PaymentGatewayError);
    });
  });
});
