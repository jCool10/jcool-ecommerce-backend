import { createHmac } from 'node:crypto';
import type { NormalizedEmail } from '@shared/kernel';
import { BUCKET_COUNT } from './uuid-v8.codec';

// Fixed public input, so the fingerprint depends on the key alone and needs no rows to exist.
const KEY_FINGERPRINT_SENTINEL = 'identity-key-fingerprint-v1';
const KEY_FINGERPRINT_HEX_CHARS = 16;

/**
 * Shortest key accepted anywhere the bucket is derived. Length is not entropy — the key must be
 * CSPRNG-drawn, which no check can prove — but a short key is offline-brute-forceable from a handful
 * of self-registered (email, bucket) pairs, which reopens the oracle the HMAC exists to close.
 */
export const MIN_BUCKET_KEY_LENGTH = 32;

/**
 * Routing bucket for a user, keyed by HMAC rather than a plain hash: `users.id` is returned by the
 * public `POST /auth/register` and `/auth/me`, so an unkeyed digest would publish 12 authenticated
 * bits of `H(email)` per id — an offline email-confirmation oracle. The key is a parameter, not read
 * from config, so this stays pure and "same email + different key -> different bucket" is testable.
 */
export function bucketForEmail(email: NormalizedEmail, key: string): number {
  const digest = createHmac('sha256', key).update(email, 'utf8').digest();
  return digest.readUInt16BE(0) % BUCKET_COUNT;
}

/**
 * A stable, row-independent fingerprint of the bucket key. The row canary compares `bucketOf(id)`
 * against `bucketForEmail(email, currentKey)`, but the id was minted with the key of the day, so a
 * key that was wrong from row 1 matches by construction. This is the check that catches that — and
 * the 0-row deploy the canary cannot see at all.
 */
export function identityKeyFingerprint(key: string): string {
  return createHmac('sha256', key).update(KEY_FINGERPRINT_SENTINEL).digest('hex').slice(0, KEY_FINGERPRINT_HEX_CHARS);
}
