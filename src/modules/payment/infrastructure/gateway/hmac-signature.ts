import { createHmac, timingSafeEqual } from 'node:crypto';
import type { VerifiedEvent } from '../../application/ports/payment-gateway.port';

// Stripe-style webhook signature scheme, shared verbatim by the real Stripe adapter and the
// test fake signer so the two can never drift. Signed payload is `${timestamp}.${rawBody}`;
// the header is `t=<unix-seconds>,v1=<hex-hmac-sha256>`.

const SIGNATURE_ALGORITHM = 'sha256';

export function signStripeStyle(secret: string, timestampSec: number, rawBody: Buffer | string): string {
  const raw = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
  const signature = createHmac(SIGNATURE_ALGORITHM, secret).update(`${timestampSec}.${raw}`).digest('hex');
  return `t=${timestampSec},v1=${signature}`;
}

interface ParsedHeader {
  timestamp: number;
  signature: string;
}

function parseHeader(header: string | undefined): ParsedHeader | null {
  if (!header) return null;
  let timestamp: number | undefined;
  let signature: string | undefined;
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't' && value !== '') timestamp = Number(value);
    else if (key === 'v1' && value !== '') signature = value;
  }
  if (timestamp === undefined || !Number.isFinite(timestamp) || !signature) return null;
  return { timestamp, signature };
}

// Constant-time compare of two hex signatures. Decode first and compare BYTE lengths: comparing
// hex-string lengths instead would let a malformed (non-hex) provided signature silently truncate
// on decode and crash timingSafeEqual on mismatched buffer sizes — turning an attacker-controlled
// header into a throw rather than an `invalid_signature` verdict.
function signaturesMatch(expectedHex: string, providedHex: string): boolean {
  const expected = Buffer.from(expectedHex, 'hex');
  const provided = Buffer.from(providedHex, 'hex');
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

export type SignatureVerdict = 'valid' | 'invalid_signature' | 'expired_timestamp';

export function verifyStripeStyle(params: {
  secret: string;
  header: string | undefined;
  rawBody: Buffer | string;
  toleranceSec: number;
  nowSec: number;
}): SignatureVerdict {
  const parsed = parseHeader(params.header);
  if (!parsed) return 'invalid_signature';

  const raw = typeof params.rawBody === 'string' ? params.rawBody : params.rawBody.toString('utf8');
  const expected = createHmac(SIGNATURE_ALGORITHM, params.secret).update(`${parsed.timestamp}.${raw}`).digest('hex');
  if (!signaturesMatch(expected, parsed.signature)) return 'invalid_signature';

  // Timestamp is now authenticated (it is inside the signed payload), so it can be trusted for
  // replay defense: reject anything outside the tolerance window in either direction.
  if (Math.abs(params.nowSec - parsed.timestamp) > params.toleranceSec) return 'expired_timestamp';
  return 'valid';
}

const HEADER_STRIPE_SIGNATURE = 'stripe-signature';

// Verify the signature, then (only on success) parse the authenticated body into a VerifiedEvent.
// Shared by the Stripe and fake adapters. A valid signature over a body missing a usable id/type
// is a real anomaly from an authentic sender, so it throws loud rather than silently degrading.
export function verifyAndParseStripeEvent(params: {
  secret: string;
  toleranceSec: number;
  rawBody: Buffer;
  headers: Record<string, string>;
  nowSec?: number;
}): VerifiedEvent {
  const header = params.headers[HEADER_STRIPE_SIGNATURE] ?? params.headers['Stripe-Signature'];
  const verdict = verifyStripeStyle({
    secret: params.secret,
    header,
    rawBody: params.rawBody,
    toleranceSec: params.toleranceSec,
    nowSec: params.nowSec ?? Math.floor(Date.now() / 1000),
  });
  if (verdict !== 'valid') return { kind: verdict };

  const parsed = JSON.parse(params.rawBody.toString('utf8')) as Record<string, unknown>;
  const id = parsed?.id;
  const type = parsed?.type;
  if (typeof id !== 'string' || id.length === 0 || typeof type !== 'string' || type.length === 0) {
    throw new Error('webhook signature valid but body is missing a string id/type');
  }
  return { kind: 'valid', providerEventId: id, type, payload: parsed };
}
