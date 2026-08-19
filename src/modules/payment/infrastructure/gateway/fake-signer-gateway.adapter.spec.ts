import { describe, expect, it } from 'vitest';
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
});
