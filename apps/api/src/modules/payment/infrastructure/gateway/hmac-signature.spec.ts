import { describe, expect, it } from 'vitest';
import { signStripeStyle, verifyStripeStyle, verifyAndParseStripeEvent } from './hmac-signature';

const SECRET = 'whsec_test_secret_value_0000';
const NOW = 1_700_000_000; // fixed reference time so tolerance tests are deterministic
const TOLERANCE = 300;

function body(overrides: Record<string, unknown> = {}): Buffer {
  return Buffer.from(JSON.stringify({ id: 'evt_123', type: 'payment_intent.succeeded', ...overrides }));
}

describe('verifyStripeStyle', () => {
  it('accepts a signature it produced for the same body, secret and time', () => {
    const raw = body();
    const header = signStripeStyle(SECRET, NOW, raw);
    expect(verifyStripeStyle({ secret: SECRET, header, rawBody: raw, toleranceSec: TOLERANCE, nowSec: NOW })).toBe(
      'valid',
    );
  });

  it('rejects a tampered body as invalid_signature', () => {
    const header = signStripeStyle(SECRET, NOW, body());
    const tampered = body({ id: 'evt_evil' });
    expect(verifyStripeStyle({ secret: SECRET, header, rawBody: tampered, toleranceSec: TOLERANCE, nowSec: NOW })).toBe(
      'invalid_signature',
    );
  });

  it('rejects a signature made with a different secret', () => {
    const raw = body();
    const header = signStripeStyle('another_secret_entirely_00', NOW, raw);
    expect(verifyStripeStyle({ secret: SECRET, header, rawBody: raw, toleranceSec: TOLERANCE, nowSec: NOW })).toBe(
      'invalid_signature',
    );
  });

  it('rejects a malformed / missing header as invalid_signature', () => {
    const raw = body();
    const headers = [
      undefined,
      '',
      'garbage',
      't=,v1=', // empty values
      `v1=${'a'.repeat(64)}`, // no timestamp
      `t=${NOW}`, // no signature
      `t=${NOW},v1=${'z'.repeat(64)}`, // non-hex v1 (would crash timingSafeEqual pre-fix)
      `t=${NOW},v1=${'a'.repeat(63)}z`, // odd-length / non-hex tail
      `t=${NOW},v1=deadbeef`, // valid hex, wrong length
    ];
    for (const header of headers) {
      // Must return a verdict, never throw — the port contract depends on it (no 4th outcome).
      expect(() =>
        verifyStripeStyle({ secret: SECRET, header, rawBody: raw, toleranceSec: TOLERANCE, nowSec: NOW }),
      ).not.toThrow();
      expect(verifyStripeStyle({ secret: SECRET, header, rawBody: raw, toleranceSec: TOLERANCE, nowSec: NOW })).toBe(
        'invalid_signature',
      );
    }
  });

  // Signing-secret rotation: the sender signs one body under every active secret and sends them all,
  // so the valid one may sit anywhere among them.
  it.each([
    ['first', (valid: string, other: string) => `${valid},${other}`],
    ['last', (valid: string, other: string) => `${other},${valid}`],
  ])('accepts a header carrying several v1 signatures when ours is %s', (_position, arrange) => {
    const raw = body();
    const validSig = signStripeStyle(SECRET, NOW, raw).split('v1=')[1];
    const header = `t=${NOW},${arrange(`v1=${validSig}`, `v1=${'0'.repeat(64)}`)}`;
    expect(verifyStripeStyle({ secret: SECRET, header, rawBody: raw, toleranceSec: TOLERANCE, nowSec: NOW })).toBe(
      'valid',
    );
  });

  it('still rejects when a multi-signature header carries no signature of ours', () => {
    const raw = body();
    const header = `t=${NOW},v1=${'0'.repeat(64)},v1=${'z'.repeat(64)}`;
    expect(verifyStripeStyle({ secret: SECRET, header, rawBody: raw, toleranceSec: TOLERANCE, nowSec: NOW })).toBe(
      'invalid_signature',
    );
  });

  it('rejects a validly-signed but stale timestamp as expired_timestamp (replay defense)', () => {
    const staleTs = NOW - TOLERANCE - 1;
    const raw = body();
    const header = signStripeStyle(SECRET, staleTs, raw);
    expect(verifyStripeStyle({ secret: SECRET, header, rawBody: raw, toleranceSec: TOLERANCE, nowSec: NOW })).toBe(
      'expired_timestamp',
    );
  });

  it('rejects a timestamp too far in the future as expired_timestamp (clock skew)', () => {
    const futureTs = NOW + TOLERANCE + 1;
    const raw = body();
    const header = signStripeStyle(SECRET, futureTs, raw);
    expect(verifyStripeStyle({ secret: SECRET, header, rawBody: raw, toleranceSec: TOLERANCE, nowSec: NOW })).toBe(
      'expired_timestamp',
    );
  });

  it('accepts a timestamp exactly at the tolerance edge', () => {
    const edgeTs = NOW - TOLERANCE;
    const raw = body();
    const header = signStripeStyle(SECRET, edgeTs, raw);
    expect(verifyStripeStyle({ secret: SECRET, header, rawBody: raw, toleranceSec: TOLERANCE, nowSec: NOW })).toBe(
      'valid',
    );
  });

  it('prefers invalid_signature over expired_timestamp: an unsigned stale forgery is invalid', () => {
    // A stale forged sig must fail on the signature, not leak that its timestamp was old.
    const staleTs = NOW - TOLERANCE - 1;
    const raw = body();
    const forged = `t=${staleTs},v1=${'0'.repeat(64)}`;
    expect(
      verifyStripeStyle({ secret: SECRET, header: forged, rawBody: raw, toleranceSec: TOLERANCE, nowSec: NOW }),
    ).toBe('invalid_signature');
  });
});

describe('verifyAndParseStripeEvent', () => {
  it('returns valid with providerEventId + type extracted from the authenticated body', () => {
    const raw = body();
    const header = signStripeStyle(SECRET, NOW, raw);
    const result = verifyAndParseStripeEvent({
      secret: SECRET,
      toleranceSec: TOLERANCE,
      rawBody: raw,
      headers: { 'stripe-signature': header },
      nowSec: NOW,
    });
    expect(result).toEqual({
      kind: 'valid',
      providerEventId: 'evt_123',
      type: 'payment_intent.succeeded',
      payload: { id: 'evt_123', type: 'payment_intent.succeeded' },
    });
  });

  it('reads the Stripe-Signature header case-insensitively', () => {
    const raw = body();
    const header = signStripeStyle(SECRET, NOW, raw);
    const result = verifyAndParseStripeEvent({
      secret: SECRET,
      toleranceSec: TOLERANCE,
      rawBody: raw,
      headers: { 'Stripe-Signature': header },
      nowSec: NOW,
    });
    expect(result.kind).toBe('valid');
  });

  it('surfaces the verdict without parsing when the signature is invalid', () => {
    const raw = body();
    const result = verifyAndParseStripeEvent({
      secret: SECRET,
      toleranceSec: TOLERANCE,
      rawBody: raw,
      headers: { 'stripe-signature': 'garbage' },
      nowSec: NOW,
    });
    expect(result).toEqual({ kind: 'invalid_signature' });
  });

  it('throws loud when a validly-signed body is missing a usable id/type', () => {
    const raw = Buffer.from(JSON.stringify({ type: 'payment_intent.succeeded' })); // no id
    const header = signStripeStyle(SECRET, NOW, raw);
    expect(() =>
      verifyAndParseStripeEvent({
        secret: SECRET,
        toleranceSec: TOLERANCE,
        rawBody: raw,
        headers: { 'stripe-signature': header },
        nowSec: NOW,
      }),
    ).toThrow(/missing a string id\/type/);
  });
});
