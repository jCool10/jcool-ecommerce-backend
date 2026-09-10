// Mirrors the `auth:denylist:` convention in redis-token-denylist.ts. Shared with the issuer, which
// writes this key on every mint and every bump — the two sides must never spell it differently.
export const AUTH_EPOCH_KEY_PREFIX = 'auth:epoch:';

export function authEpochKey(userId: string): string {
  return `${AUTH_EPOCH_KEY_PREFIX}${userId}`;
}
