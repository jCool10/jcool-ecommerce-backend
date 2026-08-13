import { createHash } from 'node:crypto';

/** SHA-256 (hex) of a value — the shared digest for opaque high-entropy tokens (fast by design: they're random secrets, not passwords). */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
