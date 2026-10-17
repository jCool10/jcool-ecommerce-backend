import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_HEADER = 'signature';

const HEX_SHA256 = /^[0-9a-f]{64}$/;

/**
 * The broker has no auth, so anything on the private network can produce to a topic. The signature
 * covers the value bytes only: a replayed message is the inbox's job, a moved one the topic check's.
 */
export function signValue(key: string, value: Buffer): string {
  return createHmac('sha256', key).update(value).digest('hex');
}

export function hasValidSignature(key: string, value: Buffer, header: Buffer | undefined): boolean {
  // Checked before decoding: timingSafeEqual throws on a length mismatch.
  const hex = header?.toString('latin1');
  if (!hex || !HEX_SHA256.test(hex)) return false;
  return timingSafeEqual(Buffer.from(hex, 'hex'), createHmac('sha256', key).update(value).digest());
}
