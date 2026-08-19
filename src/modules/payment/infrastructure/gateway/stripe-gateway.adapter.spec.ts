import { describe, expect, it } from 'vitest';
import { StripeGatewayAdapter } from './stripe-gateway.adapter';
import { signStripeStyle } from './hmac-signature';

const SECRET = 'whsec_test_secret_value_0000';

function adapter(): StripeGatewayAdapter {
  return new StripeGatewayAdapter({ webhookSecret: SECRET, toleranceSec: 300 });
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
