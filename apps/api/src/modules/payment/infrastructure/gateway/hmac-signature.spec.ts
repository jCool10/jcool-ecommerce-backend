import Stripe from 'stripe';
import { describe, expect, it } from 'vitest';
import { signStripeStyle, verifyStripeStyle, verifyAndParseStripeEvent } from './hmac-signature';

const SECRET = 'whsec_test_secret_value_0000';
const NOW = 1_700_000_000; // fixed reference time so tolerance tests are deterministic
const TOLERANCE = 300;

function body(overrides: Record<string, unknown> = {}): Buffer {
  return Buffer.from(JSON.stringify({ id: 'evt_123', type: 'payment_intent.succeeded', ...overrides }));
}

function verify(header: string | undefined, rawBody: Buffer = body()) {
  return verifyStripeStyle({ secret: SECRET, header, rawBody, toleranceSec: TOLERANCE, nowSec: NOW });
}

describe('verifyStripeStyle', () => {
  it('accepts a signature it produced for the same body, secret and time', () => {
    expect(verify(signStripeStyle(SECRET, NOW, body()))).toBe('valid');
  });

  it('rejects a tampered body as invalid_signature', () => {
    expect(verify(signStripeStyle(SECRET, NOW, body()), body({ id: 'evt_evil' }))).toBe('invalid_signature');
  });

  it('rejects a signature made with a different secret', () => {
    expect(verify(signStripeStyle('another_secret_entirely_00', NOW, body()))).toBe('invalid_signature');
  });

  it('rejects a malformed / missing header as invalid_signature', () => {
    const headers = [
      undefined,
      '',
      'garbage',
      't=,v1=', // empty values
      `v1=${'a'.repeat(64)}`, // no timestamp
      `t=${NOW}`, // no signature
      `t=${NOW},v1=${'z'.repeat(64)}`, // non-hex v1 (once crashed timingSafeEqual)
      `t=${NOW},v1=${'a'.repeat(63)}z`, // odd-length / non-hex tail
      `t=${NOW},v1=deadbeef`, // valid hex, wrong length
    ];
    for (const header of headers) {
      // A verdict, never a throw: the header is attacker-controlled and the port has no fourth outcome.
      expect(() => verify(header), header).not.toThrow();
      expect(verify(header), header).toBe('invalid_signature');
    }
  });

  // Signing-secret rotation: the sender signs one body under every active secret and sends them all,
  // so the valid one may sit anywhere among them.
  it('accepts a header carrying several v1 signatures wherever ours sits', () => {
    const ours = signStripeStyle(SECRET, NOW, body()).split(',')[1];
    const other = `v1=${'0'.repeat(64)}`;

    expect([`t=${NOW},${ours},${other}`, `t=${NOW},${other},${ours}`].map((header) => verify(header))).toEqual([
      'valid',
      'valid',
    ]);
  });

  it('still rejects when a multi-signature header carries no signature of ours', () => {
    expect(verify(`t=${NOW},v1=${'0'.repeat(64)},v1=${'z'.repeat(64)}`)).toBe('invalid_signature');
  });

  it('rejects a validly-signed timestamp outside the tolerance in either direction', () => {
    const skews = [-TOLERANCE - 1, TOLERANCE + 1];

    expect(skews.map((skew) => verify(signStripeStyle(SECRET, NOW + skew, body())))).toEqual([
      'expired_timestamp',
      'expired_timestamp',
    ]);
  });

  it('accepts a timestamp exactly at the tolerance edge', () => {
    expect(verify(signStripeStyle(SECRET, NOW - TOLERANCE, body()))).toBe('valid');
  });

  // A stale forgery must fail on the signature, not leak that its timestamp was old.
  it('prefers invalid_signature over expired_timestamp for an unsigned stale forgery', () => {
    expect(verify(`t=${NOW - TOLERANCE - 1},v1=${'0'.repeat(64)}`)).toBe('invalid_signature');
  });
});

describe('verifyAndParseStripeEvent', () => {
  it('returns valid with providerEventId + type extracted from the authenticated body', () => {
    const raw = body();
    const result = verifyAndParseStripeEvent({
      secret: SECRET,
      toleranceSec: TOLERANCE,
      rawBody: raw,
      headers: { 'stripe-signature': signStripeStyle(SECRET, NOW, raw) },
      nowSec: NOW,
    });

    expect(result).toEqual({
      kind: 'valid',
      providerEventId: 'evt_123',
      type: 'payment_intent.succeeded',
      payload: { id: 'evt_123', type: 'payment_intent.succeeded' },
    });
  });
});

// Every other tier signs with our own signer, so a wrong shared scheme would pass everywhere while
// every real Stripe delivery 401s.
describe('Stripe SDK interop', () => {
  it('accepts headers the Stripe SDK signs, and signs headers the SDK accepts', () => {
    const payload = body().toString('utf8');
    const stripeHeader = Stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET, timestamp: NOW });

    expect(verify(stripeHeader)).toBe('valid');

    // constructEvent checks tolerance against the real clock, so this direction signs at now.
    const ours = signStripeStyle(SECRET, Math.floor(Date.now() / 1000), payload);
    expect(Stripe.webhooks.constructEvent(payload, ours, SECRET)).toMatchObject({ id: 'evt_123' });
  });
});
