import { createHmac } from 'node:crypto';
import type { NormalizedEmail } from '@shared/kernel';
import { BUCKET_COUNT } from './uuid-v8.codec';

// Fixed public input, so the fingerprint depends on the key alone and needs no rows to exist.
const KEY_FINGERPRINT_SENTINEL = 'identity-key-fingerprint-v1';
const KEY_FINGERPRINT_HEX_CHARS = 16;

/** Length is not entropy, but a short key is brute-forceable from a handful of self-registered (email, bucket) pairs, which reopens the oracle the HMAC closes. */
export const MIN_BUCKET_KEY_LENGTH = 32;

/**
 * Routing bucket for a user. Keyed HMAC rather than a plain hash because `users.id` is returned by
 * the public `POST /auth/register` and `/auth/me`, so an unkeyed digest would publish 12 bits of
 * `H(email)` per id — an offline email-confirmation oracle. The key is a parameter, not config, so
 * this stays pure.
 */
export function bucketForEmail(email: NormalizedEmail, key: string): number {
  const digest = createHmac('sha256', key).update(email, 'utf8').digest();
  return digest.readUInt16BE(0) % BUCKET_COUNT;
}

/** Row-independent fingerprint of the bucket key: it holds on a 0-row database, which the row canary cannot cover, and catches a key that was wrong from the very first row. */
export function identityKeyFingerprint(key: string): string {
  return createHmac('sha256', key).update(KEY_FINGERPRINT_SENTINEL).digest('hex').slice(0, KEY_FINGERPRINT_HEX_CHARS);
}
