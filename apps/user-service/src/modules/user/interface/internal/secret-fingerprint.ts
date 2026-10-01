import { createHmac } from 'node:crypto';

// Fixed forever: a digest read back today stays comparable with one taken before.
const FINGERPRINT_SENTINEL = 'identity-key-fingerprint-v1';
const FINGERPRINT_HEX_CHARS = 16;

/** Identifies a secret without revealing it: the secret keys an HMAC over a fixed public input. */
export function secretFingerprint(secret: string): string {
  return createHmac('sha256', secret).update(FINGERPRINT_SENTINEL).digest('hex').slice(0, FINGERPRINT_HEX_CHARS);
}
