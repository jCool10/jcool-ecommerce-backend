import { createHash } from 'node:crypto';

/**
 * SHA-256 (hex) of an opaque refresh token — the single hashing rule shared by
 * issue (persist) and verify (refresh/logout lookup). A pure module so the two
 * sides can't drift to a different digest.
 */
export function hashRefreshToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}
