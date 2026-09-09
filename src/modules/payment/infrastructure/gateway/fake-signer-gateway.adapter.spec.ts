import { describe, expect, it } from 'vitest';
import { PaymentGatewayError } from '../../application/ports/payment-gateway.port';
import { FakeSignerGatewayAdapter } from './fake-signer-gateway.adapter';

const SECRET = 'whsec_test_secret_value_0000';

function fixtureBody(): Buffer {
  return Buffer.from(JSON.stringify({ id: 'evt_fake', type: 'payment_intent.succeeded' }));
}

describe('FakeSignerGatewayAdapter', () => {
  const nowSec = Math.floor(Date.now() / 1000);

  it('round-trips its own signed fixture as valid (real HMAC, not a mock)', () => {
    const gateway = new FakeSignerGatewayAdapter(SECRET);
    const raw = fixtureBody();
    const header = gateway.sign(raw, nowSec);
    expect(gateway.verifyAndParseEvent(raw, { 'stripe-signature': header })).toMatchObject({
      kind: 'valid',
      providerEventId: 'evt_fake',
    });
  });

  it('builds a fixture another instance with the same secret verifies (shared scheme)', () => {
    const raw = fixtureBody();
    const header = new FakeSignerGatewayAdapter(SECRET).sign(raw, nowSec);
    expect(new FakeSignerGatewayAdapter(SECRET).verifyAndParseEvent(raw, { 'stripe-signature': header })).toMatchObject(
      { kind: 'valid' },
    );
  });

  it('produces invalid_signature fixtures (wrong secret)', () => {
    const raw = fixtureBody();
    const header = new FakeSignerGatewayAdapter('a_different_secret_00000').sign(raw, nowSec);
    expect(new FakeSignerGatewayAdapter(SECRET).verifyAndParseEvent(raw, { 'stripe-signature': header })).toEqual({
      kind: 'invalid_signature',
    });
  });

  it('produces expired_timestamp fixtures (outside the tolerance window)', () => {
    const gateway = new FakeSignerGatewayAdapter(SECRET, 300);
    const raw = fixtureBody();
    const header = gateway.sign(raw, nowSec - 301);
    expect(gateway.verifyAndParseEvent(raw, { 'stripe-signature': header })).toEqual({ kind: 'expired_timestamp' });
  });

  it('creates a deterministic fake session handle', async () => {
    const session = await new FakeSignerGatewayAdapter(SECRET).createSession({
      orderId: 'o1',
      amountMinor: 1500,
      currency: 'USD',
    });
    expect(session.providerSessionId).toMatch(/^cs_fake_[0-9a-f]+$/);
    expect(session.redirectUrl).toContain(session.providerSessionId);
  });

  // The sweep settles a paid session only against money matching the payment row, so the double has
  // to answer with the charge it was asked to collect — in the lowercase Stripe answers with, or
  // every probe here would skip the guard's case-folding that production always goes through.
  it('reports the charge of a session it issued, lowercased as the real gateway echoes it', async () => {
    const gateway = new FakeSignerGatewayAdapter(SECRET);
    const session = await gateway.createSession({ orderId: 'o1', amountMinor: 150_000, currency: 'VND' });
    gateway.setPaymentStatus(session.providerSessionId, 'PAID');

    await expect(gateway.getPaymentStatus(session.providerSessionId)).resolves.toMatchObject({
      status: 'PAID',
      amountMinor: 150_000,
      currency: 'vnd',
    });
  });

  describe('expireSession', () => {
    it('closes an open session and records it as no longer payable', async () => {
      const gateway = new FakeSignerGatewayAdapter(SECRET);

      await expect(gateway.expireSession('cs_open')).resolves.toBe('expired');
      expect(gateway.wasExpired('cs_open')).toBe(true);
    });

    // The redelivery after a consume that expired the session and then rolled back. A double that
    // answered `expired` twice would let a caller mistake the second attempt for the first.
    it('reports a second close as a no-op rather than another success', async () => {
      const gateway = new FakeSignerGatewayAdapter(SECRET);
      await gateway.expireSession('cs_open');

      await expect(gateway.expireSession('cs_open')).resolves.toBe('already_closed');
    });

    it('reports a paid session as already completed, leaving it payable-in-fact', async () => {
      const gateway = new FakeSignerGatewayAdapter(SECRET);
      gateway.setPaymentStatus('cs_paid', 'PAID');

      await expect(gateway.expireSession('cs_paid')).resolves.toBe('already_completed');
      expect(gateway.wasExpired('cs_paid')).toBe(false);
    });

    it('throws for a staged outage, as the real adapter does', async () => {
      const gateway = new FakeSignerGatewayAdapter(SECRET);
      gateway.failExpireSession('cs_stuck');

      await expect(gateway.expireSession('cs_stuck')).rejects.toBeInstanceOf(PaymentGatewayError);
    });
  });
});
