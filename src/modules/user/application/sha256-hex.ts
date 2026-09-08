import { createHash } from 'node:crypto';

/** Fast by design: these inputs are opaque high-entropy secrets, not passwords. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
